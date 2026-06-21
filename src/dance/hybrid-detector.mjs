// HybridDetector — port of ProjectMFramework/HybridDetector.swift
// SuperFlux onset detection + cumulative score function + 181-state Viterbi tempo tracker.
// Drop-in interface: update(analyser, dt, now). Reads spectral magnitudes from a Web
// Audio AnalyserNode (fftSize=1024, smoothingTimeConstant=0) instead of running its
// own FFT — everything downstream of the magnitude buffer matches the Swift original.

const BPM_MIN = 40;
const BPM_MAX = 220;
const BPM_STATES = 181;	// 40..220 inclusive

// Band ranges in bin indices (fftSize=1024). Differ slightly from Swift's
// 44.1k assumptions but match the spec in the porting brief.
const BASS_BIN_LO = 0,  BASS_BIN_HI = 8;	// 0..345 Hz @ 44.1k
const MID_BIN_LO  = 8,  MID_BIN_HI  = 64;	// 345..2756 Hz
const TREB_BIN_LO = 64, TREB_BIN_HI = 256;	// 2756..11025 Hz
// SuperFlux high-band click confirmation (~2-6 kHz). Kicks have a click here;
// bass notes don't. This is what distinguishes them in the dual-band check.
const HIGH_BIN_LO = 46, HIGH_BIN_HI = 139;

const SUPERFLUX_MAX_W = 3;	// ±3 bins for the max filter

const SCORE_BUFFER_SIZE = 256;
const FLUX_HISTORY_LEN  = 32;

export class HybridDetector {
	constructor(sampleRate, fftSize = 1024) {
		this.sampleRate = sampleRate;
		this.fftSize = fftSize;
		this.halfN = fftSize >> 1;

		// Public outputs — match BeatDetector interface exactly
		this.bassEnergy = 0;
		this.midEnergy = 0;
		this.trebEnergy = 0;
		this.isBeat = false;
		this.estimatedBPM = 0;
		this.isDownbeat = false;
		this.beatInBar = 0;
		this.kickDensity = 0;
		this.snareProminence = 0;
		this.energyDropRatio = 1.0;
		this.beatPredictionConfidence = 0;
		this.lastBeatTime = -1.0;
		this.vibeIntensity = 0;

		// Magnitude buffers (linear, scaled to roughly match Swift's vDSP_zvabs output)
		this._magsDb = new Float32Array(this.halfN);
		this._mag = new Float32Array(this.halfN);
		this._prevMag = new Float32Array(this.halfN);
		this._maxFilteredPrev = new Float32Array(this.halfN);
		this._flux = new Float32Array(this.halfN);

		// Band peak envelopes for normalised energy outputs
		this._runningPeakBass = 0.001;
		this._runningPeakMid = 0.001;
		this._runningPeakTreb = 0.001;
		this._attackAlpha = 0.4;
		this._decayAlpha = 0.08;

		// Spectral flux state
		this._fluxHistory = new Float32Array(FLUX_HISTORY_LEN);
		this._fluxHistoryIndex = 0;
		this._fluxThresholdWindowHalf = 7;
		this._fluxThresholdOffset = 0.005;
		this._beatCooldownInterval = 0.15;
		this._lastBassOnsetTime = -1.0;
		this._prevBassFlux = 0;
		this._minAbsoluteFlux = 0.005;

		// Cumulative score (circular buffer)
		this._scoreBuffer = new Float32Array(SCORE_BUFFER_SIZE);
		this._scoreIndex = 0;

		// Viterbi distribution over 181 BPM states
		this._viterbiProb = new Float32Array(BPM_STATES);
		const seed = 1.0 / BPM_STATES;
		for(let i = 0; i < BPM_STATES; i++) this._viterbiProb[i] = seed;
		this._viterbiInitialized = false;

		// Beat timestamp history for BPM bootstrap
		this._beatTimestamps = [];
		this._maxBeatTimestamps = 24;
		this._recentIntervals = [];

		// Style inference (4-second rolling window)
		this._bassOnsetCount = 0;
		this._midOnsetCount = 0;
		this._detectedBeatCount = 0;
		this._styleWindowStart = 0;
		this._styleWindowDuration = 4.0;
		this._styleRecentPeakEnergy = 0.001;
		this._bassOnsetFluxThreshold = 0.003;
		this._midOnsetFluxThreshold = 0.003;
		this._midOnlyOnsetCount = 0;
		this._bassOnsetCountForSnare = 0;

		// Downbeat
		this._downbeatCounter = 0;
		this._recentBeatEnergies = [];

		// Hop timing — running average dt so cumulative score's "beat period in frames"
		// stays meaningful at rAF's ~60Hz vs Swift's fixed 86Hz hop rate
		this._avgHopDt = 1 / 60;
		this._lastProcessTime = 0;

		// Temporal mid-band mask after strong bass onset (~100ms)
		this._suppressMidUntil = 0;

		// Counters / start time (set on first update)
		this._beatCount = 0;
		this._startTime = 0;
	}

	reset() {
		this.bassEnergy = 0;
		this.midEnergy = 0;
		this.trebEnergy = 0;
		this.isBeat = false;
		this.vibeIntensity = 0;
		this.estimatedBPM = 0;
		this.isDownbeat = false;
		this.beatInBar = 0;
		this.kickDensity = 0;
		this.snareProminence = 0;
		this.energyDropRatio = 1.0;
		this.beatPredictionConfidence = 0;
		this.lastBeatTime = -1.0;

		this._mag.fill(0);
		this._prevMag.fill(0);
		this._fluxHistory.fill(0);
		this._fluxHistoryIndex = 0;
		this._lastBassOnsetTime = -1.0;
		this._prevBassFlux = 0;
		this._beatTimestamps = [];
		this._recentIntervals = [];
		this._midOnlyOnsetCount = 0;
		this._bassOnsetCountForSnare = 0;
		this._scoreBuffer.fill(0);
		this._scoreIndex = 0;
		this._viterbiInitialized = false;
		const seed = 1.0 / BPM_STATES;
		for(let i = 0; i < BPM_STATES; i++) this._viterbiProb[i] = seed;
		this._suppressMidUntil = 0;
		this._downbeatCounter = 0;
		this._recentBeatEnergies = [];
		this._beatCount = 0;
		this._lastProcessTime = 0;
		this._avgHopDt = 1 / 60;
		this._startTime = 0;
	}

	configure(opts = {}) {
		if(opts.thresholdOffset != null)     this._fluxThresholdOffset = opts.thresholdOffset;
		if(opts.thresholdWindowHalf != null) this._fluxThresholdWindowHalf = opts.thresholdWindowHalf;
		if(opts.cooldown != null)            this._beatCooldownInterval = opts.cooldown;
		if(opts.minFlux != null)             this._minAbsoluteFlux = opts.minFlux;
		if(opts.maxTimestamps != null)       this._maxBeatTimestamps = opts.maxTimestamps;
	}

	// Main entry point. now = performance.now()/1000.
	update(analyser, dt, now) {
		if(this._startTime === 0) this._startTime = now;

		// Pull spectrum and convert dB → linear. Web Audio's getFloatFrequencyData
		// returns dB in [-160, 0]; floor at minDecibels to avoid NaN/zero issues.
		const halfN = this.halfN;
		if(analyser.frequencyBinCount !== halfN) {
			// Caller used a different fftSize — resize lazily so we don't NaN out
			this.halfN = analyser.frequencyBinCount;
			this._magsDb = new Float32Array(this.halfN);
			this._mag = new Float32Array(this.halfN);
			this._prevMag = new Float32Array(this.halfN);
			this._maxFilteredPrev = new Float32Array(this.halfN);
			this._flux = new Float32Array(this.halfN);
			return;
		}
		analyser.getFloatFrequencyData(this._magsDb);

		const mag = this._mag;
		const minDb = analyser.minDecibels;
		for(let i = 0; i < halfN; i++) {
			const db = this._magsDb[i];
			// Web Audio reports -Infinity for silent bins; clamp to minDb
			mag[i] = (db <= minDb || !isFinite(db)) ? 0 : Math.pow(10, db / 20);
		}

		this.isBeat = false;
		this.isDownbeat = false;

		this._processOneHop(now);

		const beatBoost = this.isBeat ? 0.4 : 0;
		this.vibeIntensity = Math.min(1.0,
			this.bassEnergy * 0.5 + this.midEnergy * 0.2 + this.trebEnergy * 0.1 + beatBoost);

		// Track running average of frame dt — used by cumulative score to convert
		// the current BPM estimate into a frame-period lookback
		if(this._lastProcessTime > 0) {
			const procDt = now - this._lastProcessTime;
			if(procDt > 0 && procDt < 0.2) {
				this._avgHopDt = this._avgHopDt * 0.9 + procDt * 0.1;
			}
		}
		this._lastProcessTime = now;
	}

	_processOneHop(now) {
		const halfN = this.halfN;
		const mag = this._mag;
		const prevMag = this._prevMag;
		const maxFilteredPrev = this._maxFilteredPrev;
		const flux = this._flux;

		// SuperFlux: maximum filter on previous magnitudes (±3 bins). Suppresses
		// vibrato/reverb tail bin wobble so they don't trigger spurious flux.
		const w = SUPERFLUX_MAX_W;
		for(let i = 0; i < halfN; i++) {
			const lo = Math.max(0, i - w);
			const hi = Math.min(halfN - 1, i + w);
			let m = 0;
			for(let j = lo; j <= hi; j++) {
				const v = prevMag[j];
				if(v > m) m = v;
			}
			maxFilteredPrev[i] = m;
		}

		// Half-wave rectified spectral flux
		for(let i = 0; i < halfN; i++) {
			const d = mag[i] - maxFilteredPrev[i];
			flux[i] = d > 0 ? d : 0;
		}

		const bassEnd = Math.min(BASS_BIN_HI, halfN);
		let bassFlux = 0;
		for(let i = 0; i < bassEnd; i++) bassFlux += flux[i];

		let midFlux = 0;
		const midEnd = Math.min(MID_BIN_HI, halfN);
		for(let i = MID_BIN_LO; i < midEnd; i++) midFlux += flux[i];

		let highFlux = 0;
		const highEnd = Math.min(HIGH_BIN_HI, halfN);
		for(let i = HIGH_BIN_LO; i < highEnd; i++) highFlux += flux[i];

		// Save current magnitudes for next hop
		prevMag.set(mag);

		// Band energies (sum of raw magnitudes, normalised by slow-decaying peak)
		const rawBass = this._sumBand(BASS_BIN_LO, BASS_BIN_HI);
		const rawMid  = this._sumBand(MID_BIN_LO, MID_BIN_HI);
		const rawTreb = this._sumBand(TREB_BIN_LO, TREB_BIN_HI);

		this._runningPeakBass = Math.max(this._runningPeakBass * 0.995, rawBass);
		this._runningPeakMid  = Math.max(this._runningPeakMid  * 0.995, rawMid);
		this._runningPeakTreb = Math.max(this._runningPeakTreb * 0.995, rawTreb);

		this.bassEnergy = this._smooth(this.bassEnergy, rawBass / this._runningPeakBass);
		this.midEnergy  = this._smooth(this.midEnergy,  rawMid  / this._runningPeakMid);
		this.trebEnergy = this._smooth(this.trebEnergy, rawTreb / this._runningPeakTreb);

		// Style inference window — every 4s, reset onset tallies
		if(now - this._styleWindowStart > this._styleWindowDuration) {
			this._bassOnsetCount = 0;
			this._midOnsetCount = 0;
			this._detectedBeatCount = 0;
			this._midOnlyOnsetCount = 0;
			this._bassOnsetCountForSnare = 0;
			this._styleWindowStart = now;
		}
		if(bassFlux > this._bassOnsetFluxThreshold) this._bassOnsetCount++;
		if(midFlux > this._midOnsetFluxThreshold)   this._midOnsetCount++;

		const currentCombinedEnergy = rawBass + rawMid * 0.5;
		this._styleRecentPeakEnergy = Math.max(this._styleRecentPeakEnergy * 0.999, currentCombinedEnergy);
		this.energyDropRatio = this._styleRecentPeakEnergy > 0.001
			? currentCombinedEnergy / this._styleRecentPeakEnergy
			: 1.0;

		// Adaptive flux threshold: moving-window mean over ±windowHalf frames
		const histLen = this._fluxHistory.length;
		const histIdx = this._fluxHistoryIndex % histLen;
		this._fluxHistory[histIdx] = bassFlux;
		this._fluxHistoryIndex++;

		const filledCount = Math.min(this._fluxHistoryIndex, histLen);
		let thresholdSum = 0;
		let thresholdCount = 0;
		const wHalf = this._fluxThresholdWindowHalf;
		for(let off = -wHalf; off <= wHalf; off++) {
			const idx = histIdx + off;
			const wrapped = ((idx % filledCount) + filledCount) % filledCount;
			thresholdSum += this._fluxHistory[wrapped];
			thresholdCount++;
		}
		const thresholdMean = thresholdSum / thresholdCount;
		const fluxThreshold = thresholdMean + this._fluxThresholdOffset;

		// Temporal masking: a strong bass onset suppresses mid flux for ~100ms.
		// Swift used "9 hops at 86Hz" — convert to time so rAF rate doesn't matter.
		if(bassFlux > fluxThreshold * 1.5) {
			this._suppressMidUntil = now + 0.1;
		}
		if(now < this._suppressMidUntil) {
			midFlux = 0;
		}

		// Dual-band onset confirmation. Kicks have a 2-6 kHz click; bass notes don't.
		// Bass onset = bass flux above threshold AND (high-freq click OR very strong flux).
		const highFluxThreshold = 0.003;
		const hasHighFreqClick = highFlux > highFluxThreshold;
		const bassOnset = bassFlux > fluxThreshold
			&& bassFlux > this._minAbsoluteFlux
			&& (hasHighFreqClick || bassFlux > fluxThreshold * 3.0);
		const midOnset = midFlux > (thresholdMean + this._fluxThresholdOffset)
			&& midFlux > this._minAbsoluteFlux;
		const timeSinceLastBass = now - this._lastBassOnsetTime;

		const bootstrapComplete = (now - this._startTime) > 2.0;
		const midAllowed = bootstrapComplete
			&& timeSinceLastBass > this._beatCooldownInterval * 4
			&& this.snareProminence > 0.3;

		// Sub-hop interpolation: refines onset time inside the FFT hop window
		let onsetTimeOffset = 0;
		if(bassOnset && this._prevBassFlux >= 0) {
			const total = bassFlux + this._prevBassFlux;
			if(total > 0) {
				const ratio = this._prevBassFlux / total;
				onsetTimeOffset = ratio * this._avgHopDt;
			}
		}
		this._prevBassFlux = bassFlux;

		// Snare prominence: ratio of mid-only onsets to total onsets
		if(midOnset && !bassOnset) this._midOnlyOnsetCount++;
		if(bassOnset) this._bassOnsetCountForSnare++;
		const totalSnareOnsets = this._midOnlyOnsetCount + this._bassOnsetCountForSnare;
		if(totalSnareOnsets > 4) {
			this.snareProminence = this._midOnlyOnsetCount / totalSnareOnsets;
		}

		// Cumulative score: reinforce onsets at expected beat periods (1×, 2× harmonics).
		// At rAF (~60Hz) the beat period in "frames" is ~30 for 120 BPM — fits in 256.
		const onsetStrength = Math.max(0, bassFlux - fluxThreshold);
		let cumulativeScore = onsetStrength;

		const beatPeriodFrames = this.estimatedBPM > 0
			? Math.floor(60.0 / this.estimatedBPM / this._avgHopDt)
			: 0;
		if(beatPeriodFrames > 0 && beatPeriodFrames < SCORE_BUFFER_SIZE / 2) {
			for(let harmonic = 1; harmonic <= 2; harmonic++) {
				const lookback = harmonic * beatPeriodFrames;
				if(lookback >= SCORE_BUFFER_SIZE) break;
				const idx = ((this._scoreIndex - lookback) % SCORE_BUFFER_SIZE + SCORE_BUFFER_SIZE) % SCORE_BUFFER_SIZE;
				const weight = Math.pow(0.9, harmonic);
				cumulativeScore += weight * this._scoreBuffer[idx];
			}
		}

		// Log-Gaussian prediction weighting: boost onsets near the predicted beat time
		if(this.estimatedBPM > 0 && this.lastBeatTime > 0) {
			const timeSinceLastBeat = now - this.lastBeatTime;
			const expectedBeatTime = 60.0 / this.estimatedBPM;
			const predictionError = (timeSinceLastBeat - expectedBeatTime) / expectedBeatTime;
			const predictionWeight = Math.exp(-predictionError * predictionError / 0.05);
			cumulativeScore *= (0.5 + predictionWeight * 0.5);
		}

		this._scoreBuffer[this._scoreIndex % SCORE_BUFFER_SIZE] = cumulativeScore;
		this._scoreIndex++;

		// Beat decision: adaptive cooldown scales with tempo.
		// 174 BPM → 0.21s, 85 BPM → 0.42s.
		let adaptiveCooldown;
		if(this.estimatedBPM > 0) {
			const expectedInt = 60.0 / this.estimatedBPM;
			adaptiveCooldown = Math.max(this._beatCooldownInterval, expectedInt * 0.6);
		} else {
			adaptiveCooldown = this._beatCooldownInterval;
		}
		const onCooldown = (now - this.lastBeatTime) < adaptiveCooldown;
		const timeSinceLastBeat = now - this.lastBeatTime;
		const expectedInterval = this.estimatedBPM > 0 ? 60.0 / this.estimatedBPM : 0;

		const isBeatCandidate = bassOnset || (midOnset && midAllowed);
		let detectedBeat = false;

		if(isBeatCandidate && !onCooldown) {
			detectedBeat = true;
			if(bassOnset) this._lastBassOnsetTime = now;

			if(expectedInterval > 0) {
				const predError = Math.abs(timeSinceLastBeat - expectedInterval) / expectedInterval;
				if(predError < 0.3) {
					this.beatPredictionConfidence = Math.min(1.0, this.beatPredictionConfidence + 0.1);
				} else {
					this.beatPredictionConfidence = Math.max(0, this.beatPredictionConfidence - 0.2);
				}
			}
		}
		// Predictive beat: overdue and *some* energy present
		else if(this.beatPredictionConfidence > 0.5
				&& expectedInterval > 0
				&& timeSinceLastBeat > expectedInterval * 1.2
				&& (bassFlux > fluxThreshold * 0.3 || midFlux > fluxThreshold * 0.3)
				&& !onCooldown) {
			detectedBeat = true;
			this.beatPredictionConfidence -= 0.05;
		}

		if(detectedBeat) {
			this.isBeat = true;
			const preciseTime = now - onsetTimeOffset;
			this.lastBeatTime = preciseTime;
			this._beatCount++;
			this._detectedBeatCount++;

			this._beatTimestamps.push(preciseTime);
			if(this._beatTimestamps.length > this._maxBeatTimestamps) {
				this._beatTimestamps.shift();
			}

			// Kick density from interval clustering (normal vs double-time)
			if(this._beatTimestamps.length >= 2) {
				const lastInterval = this._beatTimestamps[this._beatTimestamps.length - 1]
					- this._beatTimestamps[this._beatTimestamps.length - 2];
				this._recentIntervals.push(lastInterval);
				if(this._recentIntervals.length > 16) this._recentIntervals.shift();

				if(this._recentIntervals.length >= 4) {
					const sorted = [...this._recentIntervals].sort((a, b) => a - b);
					const median = sorted[sorted.length >> 1];
					let normalCount = 0, doubleCount = 0;
					for(const iv of this._recentIntervals) {
						if(Math.abs(iv - median) / median < 0.2) normalCount++;
						if(Math.abs(iv - median * 2) / (median * 2) < 0.2) doubleCount++;
					}
					const total = normalCount + doubleCount;
					if(total > 0) this.kickDensity = normalCount / total;
				}

				this._updateViterbiFromInterval(lastInterval);
			}

			// Downbeat detection — strong bass beats vs running average reset to 1
			this._recentBeatEnergies.push(bassFlux);
			if(this._recentBeatEnergies.length > 16) this._recentBeatEnergies.shift();

			if(this._recentBeatEnergies.length >= 4) {
				let sumE = 0;
				for(const e of this._recentBeatEnergies) sumE += e;
				const avgEnergy = sumE / this._recentBeatEnergies.length;
				if(bassFlux > avgEnergy * 1.5 && this._downbeatCounter !== 0) {
					this._downbeatCounter = 0;
				}
				if(this._recentBeatEnergies.length >= 8) {
					const sortedE = [...this._recentBeatEnergies].sort((a, b) => a - b);
					const medianE = sortedE[sortedE.length >> 1];
					if(medianE > 0.001) {
						let strongBeats = 0, weakBeats = 0;
						for(const e of this._recentBeatEnergies) {
							if(e > medianE * 2.0) strongBeats++;
							else if(e < medianE * 0.4) weakBeats++;
						}
						const total = strongBeats + weakBeats;
						if(total >= 6 && strongBeats >= 3 && weakBeats >= 3) {
							this.kickDensity = strongBeats / total;
						}
					}
				}
			}

			this.beatInBar = this._downbeatCounter;
			this.isDownbeat = (this.beatInBar === 0);
			this._downbeatCounter = (this._downbeatCounter + 1) % 4;
		}
	}

	// Viterbi tempo tracker: update on every detected beat using the observed interval.
	// 181 states span 40..220 BPM. σ=0.015 for observation, σ=0.03 for transition.
	_updateViterbiFromInterval(interval) {
		if(!(interval > 0.12 && interval < 2.0)) return;
		const observedBPM = 60.0 / interval;

		// Bootstrap: seed the Viterbi distribution from median-interval BPM
		if(!this._viterbiInitialized) {
			this._updateBPMFromIntervals();
			if(this.estimatedBPM > 0) {
				const centerIdx = Math.floor(this.estimatedBPM - BPM_MIN);
				if(centerIdx >= 0 && centerIdx < BPM_STATES) {
					for(let i = 0; i < BPM_STATES; i++) {
						const dist = Math.abs(i - centerIdx);
						this._viterbiProb[i] = Math.exp(-dist * dist / 8.0);
					}
					this._normalizeViterbi();
				}
				this._viterbiInitialized = true;
			}
			return;
		}

		const estBPM = this.estimatedBPM;
		for(let i = 0; i < BPM_STATES; i++) {
			const candidateBPM = BPM_MIN + i;

			const obsError = Math.abs(candidateBPM - observedBPM) / candidateBPM;
			const fundamentalObs = Math.exp(-obsError * obsError / 0.015);

			// Half/double matches kept tiny (5%) — octave errors are the main failure mode
			const obsHalf = Math.abs(candidateBPM - observedBPM * 2) / candidateBPM;
			const obsDouble = Math.abs(candidateBPM - observedBPM * 0.5) / candidateBPM;
			const halfObs = Math.exp(-obsHalf * obsHalf / 0.015) * 0.05;
			const doubleObs = Math.exp(-obsDouble * obsDouble / 0.015) * 0.05;

			const observation = fundamentalObs + halfObs + doubleObs;

			const transError = Math.abs(candidateBPM - estBPM) / Math.max(estBPM, 1);
			const transition = Math.exp(-transError * transError / 0.03);

			const logRatio = Math.log(candidateBPM / 120.0);
			const prior = Math.exp(-logRatio * logRatio / (2.0 * 0.9 * 0.9));

			this._viterbiProb[i] = this._viterbiProb[i] * 0.90
				+ observation * transition * prior * 0.10;
		}

		this._normalizeViterbi();

		// Argmax
		let maxVal = 0, maxIdx = 0;
		for(let i = 0; i < BPM_STATES; i++) {
			if(this._viterbiProb[i] > maxVal) {
				maxVal = this._viterbiProb[i];
				maxIdx = i;
			}
		}
		const viterbiBPM = BPM_MIN + maxIdx;

		// Octave correction: if intervals say ~2× what Viterbi says, fix Viterbi
		if(this._beatTimestamps.length >= 6) {
			const ivs = [];
			for(let k = 1; k < this._beatTimestamps.length; k++) {
				const iv = this._beatTimestamps[k] - this._beatTimestamps[k - 1];
				if(iv > 0.12 && iv < 2.0) ivs.push(iv);
			}
			if(ivs.length >= 4) {
				ivs.sort((a, b) => a - b);
				const medianIV = ivs[ivs.length >> 1];
				const intervalBPM = 60.0 / medianIV;
				const ratio = intervalBPM / viterbiBPM;
				if(ratio > 1.7 && ratio < 2.3 && viterbiBPM < 100) {
					const corrected = viterbiBPM * 2;
					const centerIdx = Math.floor(corrected - BPM_MIN);
					if(centerIdx >= 0 && centerIdx < BPM_STATES) {
						for(let i = 0; i < BPM_STATES; i++) {
							const dist = Math.abs(i - centerIdx);
							this._viterbiProb[i] = Math.exp(-dist * dist / 50.0);
						}
						this._normalizeViterbi();
					}
					this.estimatedBPM = corrected;
					return;
				}
			}
		}

		// Smooth blend toward the Viterbi argmax (faster blend when delta is small)
		if(this.estimatedBPM > 0) {
			const bpmDelta = Math.abs(viterbiBPM - this.estimatedBPM) / this.estimatedBPM;
			const alpha = bpmDelta < 0.05 ? 0.3 : (bpmDelta < 0.15 ? 0.15 : 0.05);
			this.estimatedBPM = this.estimatedBPM * (1 - alpha) + viterbiBPM * alpha;
		} else {
			this.estimatedBPM = viterbiBPM;
		}

		this._resolveSubdivision();
	}

	_updateBPMFromIntervals() {
		if(this._beatTimestamps.length < 4) return;

		const intervals = [];
		for(let i = 1; i < this._beatTimestamps.length; i++) {
			const interval = this._beatTimestamps[i] - this._beatTimestamps[i - 1];
			if(interval > 0.12 && interval < 2.0) intervals.push(interval);
		}
		if(intervals.length < 3) return;

		intervals.sort((a, b) => a - b);
		const median = intervals[intervals.length >> 1];
		const newBPM = 60.0 / median;

		if(this.estimatedBPM > 0) {
			const alpha = intervals.length >= 8 ? 0.5 : 0.3;
			const bpmDelta = Math.abs(newBPM - this.estimatedBPM) / this.estimatedBPM;
			if(bpmDelta <= 0.25) {
				this.estimatedBPM = this.estimatedBPM * (1 - alpha) + newBPM * alpha;
			}
		} else {
			this.estimatedBPM = newBPM;
		}
	}

	_resolveSubdivision() {
		if(this.estimatedBPM <= 0 || this._recentIntervals.length < 6) return;

		const halfBPM = this.estimatedBPM / 2;
		const doubleBPM = this.estimatedBPM * 2;

		if(this.estimatedBPM > 160 && halfBPM >= 50) {
			if(this.kickDensity < 0.7 && this.snareProminence > 0.2) {
				this.estimatedBPM = halfBPM;
			}
		} else if(this.estimatedBPM < 80 && doubleBPM <= 200) {
			const sorted = [...this._recentIntervals].sort((a, b) => a - b);
			const median = sorted[sorted.length >> 1];
			const intervalBPM = 60.0 / median;
			const ratio = intervalBPM / this.estimatedBPM;
			if(ratio > 1.7 && ratio < 2.3) {
				this.estimatedBPM = doubleBPM;
			}
		}
	}

	_normalizeViterbi() {
		let sum = 0;
		for(let i = 0; i < BPM_STATES; i++) sum += this._viterbiProb[i];
		if(sum > 0) {
			const inv = 1.0 / sum;
			for(let i = 0; i < BPM_STATES; i++) this._viterbiProb[i] *= inv;
		}
	}

	_sumBand(lo, hi) {
		const end = Math.min(hi, this.halfN);
		const start = Math.min(lo, end);
		let sum = 0;
		for(let i = start; i < end; i++) sum += this._mag[i];
		return sum;
	}

	_smooth(current, target) {
		const alpha = target > current ? this._attackAlpha : this._decayAlpha;
		return current + alpha * (target - current);
	}
}
