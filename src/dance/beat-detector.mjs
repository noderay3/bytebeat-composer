// Spectral-flux + autocorrelation beat detector, ported from BeatDetector.swift.
// Web Audio AnalyserNode replaces vDSP FFT; history buffers stay in tick units
// (one update() call = one history entry), so the 32-frame flux windows now
// span ~0.53s at 60Hz instead of the Swift hop's ~0.37s — close enough that
// the adaptive threshold still tracks tempo within the supported BPM range.

const TAU = Math.PI * 2;

export class BeatDetector {
	constructor(sampleRate, fftSize = 1024) {
		this.sampleRate = sampleRate;
		this.fftSize = fftSize;
		this.halfN = fftSize >> 1;

		// band ranges in FFT bins — match Swift's claim of "0..375 Hz" etc at 44.1k/1024
		this.bassBinStart = 0;
		this.bassBinEnd = 8;
		this.midBinStart = 8;
		this.midBinEnd = 64;
		this.trebBinStart = 64;
		this.trebBinEnd = Math.min(256, this.halfN);

		// public outputs
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

		// magnitudes (linear, normalized by fftSize like Swift)
		this.magnitudes = new Float32Array(this.halfN);
		this.prevMagnitudes = new Float32Array(this.halfN);
		this.fluxBuffer = new Float32Array(this.halfN);
		this._dbScratch = new Float32Array(this.halfN * 2); // reused for getFloatFrequencyData
		this._timeScratch = new Float32Array(fftSize);

		// smoothing
		this.attackAlpha = 0.4;
		this.decayAlpha = 0.08;

		// running peaks for normalization
		this.runningPeakBass = 0.001;
		this.runningPeakMid = 0.001;
		this.runningPeakTreb = 0.001;

		// flux histories (per-tick — see header comment)
		this.fluxHistory = new Float32Array(32);
		this.fluxHistoryIndex = 0;
		this.midFluxHistory = new Float32Array(32);
		this.midFluxHistoryIndex = 0;
		this.fluxThresholdWindowHalf = 7;
		this.fluxThresholdOffset = 0.005;
		this.beatCooldownInterval = 0.15;
		this.lastBassOnsetTime = -1.0;
		this.minAbsoluteFlux = 0.005;

		// BPM via beat intervals
		this.beatTimestamps = [];
		this.maxBeatTimestamps = 24;
		this.recentIntervals = [];

		// style inference
		this.bassOnsetCount = 0;
		this.midOnsetCount = 0;
		this.detectedBeatCount = 0;
		this.expectedBeatCount = 0;
		this.styleWindowStart = 0;
		this.styleWindowDuration = 4.0;
		this.styleRecentPeakEnergy = 0.001;
		this.bassOnsetFluxThreshold = 0.003;
		this.midOnsetFluxThreshold = 0.003;
		this.midOnlyOnsetCount = 0;
		this.bassOnsetCountForSnare = 0;

		// downbeat
		this.downbeatCounter = 0;
		this.recentBeatEnergies = [];

		// ODF buffer for autocorrelation (~8.5s of ticks at 60fps)
		this.odfBufferSize = 512;
		this.odfBuffer = new Float32Array(this.odfBufferSize);
		this.odfIndex = 0;

		// treble periodicity
		this.trebFluxHistory = new Float32Array(64);
		this.trebFluxIndex = 0;

		// autocorrelation tempo
		this.tempoMinBPM = 40;
		this.tempoMaxBPM = 220;
		this.tempoHistogram = new Float32Array(this.tempoMaxBPM - this.tempoMinBPM + 1);
		this.tempoHistDecay = 0.92;
		this.framesSinceAutoCorr = 0;
		this.autoCorrInterval = 30;
		this.priorCenterBPM = 120.0;
		this.priorLogSigma = 0.9;

		// effective tick rate — initialized to 60Hz, EMA-updated from dt arg
		this.avgProcessDt = 1.0 / 60.0;
		this.lastProcessTime = 0;

		// beat prediction
		this.expectedNextBeatTime = 0;

		// diagnostics
		this.beatCount = 0;
		this.processCount = 0;
	}

	reset() {
		this.bassEnergy = 0; this.midEnergy = 0; this.trebEnergy = 0;
		this.isBeat = false; this.estimatedBPM = 0;
		this.isDownbeat = false; this.beatInBar = 0;
		this.downbeatCounter = 0; this.recentBeatEnergies = [];
		this.kickDensity = 0; this.snareProminence = 0; this.energyDropRatio = 1.0;
		this.bassOnsetCount = 0; this.midOnsetCount = 0;
		this.detectedBeatCount = 0; this.expectedBeatCount = 0;
		this.styleWindowStart = 0; this.styleRecentPeakEnergy = 0.001;
		this.magnitudes.fill(0); this.prevMagnitudes.fill(0);
		this.fluxHistory.fill(0); this.fluxHistoryIndex = 0;
		this.midFluxHistory.fill(0); this.midFluxHistoryIndex = 0;
		this.lastBeatTime = -1.0; this.lastBassOnsetTime = -1.0;
		this.beatTimestamps = []; this.recentIntervals = [];
		this.midOnlyOnsetCount = 0; this.bassOnsetCountForSnare = 0;
		this.odfBuffer.fill(0); this.odfIndex = 0;
		this.tempoHistogram.fill(0); this.framesSinceAutoCorr = 0;
		this.runningPeakBass = 0.001; this.runningPeakMid = 0.001; this.runningPeakTreb = 0.001;
		this.trebFluxHistory.fill(0); this.trebFluxIndex = 0;
		this.lastProcessTime = 0;
		this.expectedNextBeatTime = 0;
		this.beatPredictionConfidence = 0;
		this.beatCount = 0; this.processCount = 0;
	}

	configure(opts = {}) {
		if(opts.thresholdOffset != null) this.fluxThresholdOffset = opts.thresholdOffset;
		if(opts.thresholdWindowHalf != null) this.fluxThresholdWindowHalf = opts.thresholdWindowHalf;
		if(opts.cooldown != null) this.beatCooldownInterval = opts.cooldown;
		if(opts.minFlux != null) this.minAbsoluteFlux = opts.minFlux;
		if(opts.maxTimestamps != null) this.maxBeatTimestamps = opts.maxTimestamps;
		if(opts.histDecay != null) this.tempoHistDecay = opts.histDecay;
		if(opts.priorCenter != null) this.priorCenterBPM = opts.priorCenter;
		if(opts.priorSigma != null) this.priorLogSigma = opts.priorSigma;
	}

	// Pull magnitudes from the analyser. AnalyserNode already applies a Blackman
	// window + FFT internally; we convert dB→linear and apply the same 1/fftSize
	// scale Swift used so absolute flux thresholds stay roughly comparable.
	_loadMagnitudes(analyser) {
		const freqCount = analyser.frequencyBinCount;
		const scratch = this._dbScratch.length >= freqCount ? this._dbScratch : (this._dbScratch = new Float32Array(freqCount));
		analyser.getFloatFrequencyData(scratch);
		const invFft = 1.0 / this.fftSize;
		const n = Math.min(this.halfN, freqCount);
		for(let i = 0; i < n; i++) {
			const db = scratch[i];
			// guard -Infinity (silent bin)
			const lin = db <= -160 ? 0 : Math.pow(10, db * 0.05);
			this.magnitudes[i] = lin * invFft;
		}
	}

	update(analyser, dt, now) {
		this.processCount++;
		this.isBeat = false;
		this.isDownbeat = false;

		this._loadMagnitudes(analyser);

		const halfN = this.halfN;

		// per-bin spectral flux with half-wave rectification
		let bassFlux = 0, midFlux = 0, trebFlux = 0;
		const bassEnd = Math.min(this.bassBinEnd, halfN);
		const midEnd = Math.min(this.midBinEnd, halfN);
		const trebEnd = Math.min(this.trebBinEnd, halfN);
		for(let i = 0; i < halfN; i++) {
			const d = this.magnitudes[i] - this.prevMagnitudes[i];
			const f = d > 0 ? d : 0;
			this.fluxBuffer[i] = f;
			if(i < bassEnd) bassFlux += f;
			else if(i < midEnd) midFlux += f;
			else if(i < trebEnd) trebFlux += f;
		}

		// treble periodicity tracking
		this.trebFluxHistory[this.trebFluxIndex % this.trebFluxHistory.length] = trebFlux;
		this.trebFluxIndex++;
		if(this.trebFluxIndex % 30 === 0 && this.estimatedBPM > 0) {
			const trebP = this._computeTrebPeriodicity();
			if(trebP > 0.3) {
				this.beatPredictionConfidence = Math.min(1.0, this.beatPredictionConfidence + 0.05);
			}
		}

		// save magnitudes for next frame
		this.prevMagnitudes.set(this.magnitudes);

		// band energies (raw sum then normalize against decaying peak)
		const rawBass = this._sumBand(this.bassBinStart, bassEnd);
		const rawMid = this._sumBand(this.midBinStart, midEnd);
		const rawTreb = this._sumBand(this.trebBinStart, trebEnd);

		this.runningPeakBass = Math.max(this.runningPeakBass * 0.995, rawBass);
		this.runningPeakMid = Math.max(this.runningPeakMid * 0.995, rawMid);
		this.runningPeakTreb = Math.max(this.runningPeakTreb * 0.995, rawTreb);

		this.bassEnergy = this._smooth(this.bassEnergy, rawBass / this.runningPeakBass);
		this.midEnergy = this._smooth(this.midEnergy, rawMid / this.runningPeakMid);
		this.trebEnergy = this._smooth(this.trebEnergy, rawTreb / this.runningPeakTreb);

		// style inference window
		if(now - this.styleWindowStart > this.styleWindowDuration) {
			this.bassOnsetCount = 0; this.midOnsetCount = 0;
			this.detectedBeatCount = 0; this.expectedBeatCount = 0;
			this.midOnlyOnsetCount = 0; this.bassOnsetCountForSnare = 0;
			this.styleWindowStart = now;
		}

		if(this.estimatedBPM > 0 && this.lastProcessTime > 0) {
			this.expectedBeatCount += this.estimatedBPM / 60.0 * dt;
		}

		if(bassFlux > this.bassOnsetFluxThreshold) this.bassOnsetCount++;
		if(midFlux > this.midOnsetFluxThreshold) this.midOnsetCount++;

		const currentCombined = rawBass + rawMid * 0.5;
		this.styleRecentPeakEnergy = Math.max(this.styleRecentPeakEnergy * 0.999, currentCombined);
		this.energyDropRatio = this.styleRecentPeakEnergy > 0.001
			? currentCombined / this.styleRecentPeakEnergy
			: 1.0;

		// BTrack-style adaptive flux threshold (centered moving window)
		const fluxThreshold = this._pushAndThreshold(this.fluxHistory, this.fluxHistoryIndex, bassFlux);
		this.fluxHistoryIndex++;
		const midFluxThreshold = this._pushAndThreshold(this.midFluxHistory, this.midFluxHistoryIndex, midFlux);
		this.midFluxHistoryIndex++;

		const onCooldown = (now - this.lastBeatTime) < this.beatCooldownInterval;
		const timeSinceLastBeat = now - this.lastBeatTime;
		const expectedInterval = this.estimatedBPM > 0 ? 60.0 / this.estimatedBPM : 0;

		const bassOnset = bassFlux > fluxThreshold && bassFlux > this.minAbsoluteFlux;
		const midOnset = midFlux > midFluxThreshold && midFlux > this.minAbsoluteFlux;

		const timeSinceLastBass = now - this.lastBassOnsetTime;
		const midAllowed = timeSinceLastBass > this.beatCooldownInterval * 4 && this.snareProminence > 0.3;
		const isBeatCandidate = bassOnset || (midOnset && midAllowed);

		if(midOnset && !bassOnset) this.midOnlyOnsetCount++;
		if(bassOnset) this.bassOnsetCountForSnare++;
		const totalSnareOnsets = this.midOnlyOnsetCount + this.bassOnsetCountForSnare;
		if(totalSnareOnsets > 4) {
			this.snareProminence = this.midOnlyOnsetCount / totalSnareOnsets;
		}

		let detectedBeat = false;
		if(isBeatCandidate && !onCooldown) {
			detectedBeat = true;
			if(bassOnset) this.lastBassOnsetTime = now;
			if(expectedInterval > 0) {
				const predError = Math.abs(timeSinceLastBeat - expectedInterval) / expectedInterval;
				this.beatPredictionConfidence = predError < 0.3
					? Math.min(1.0, this.beatPredictionConfidence + 0.1)
					: Math.max(0, this.beatPredictionConfidence - 0.2);
			}
		} else if(this.beatPredictionConfidence > 0.5
				&& expectedInterval > 0
				&& timeSinceLastBeat > expectedInterval * 1.2
				&& (bassFlux > fluxThreshold * 0.3 || midFlux > midFluxThreshold * 0.3)
				&& (bassFlux > this.minAbsoluteFlux || midFlux > this.minAbsoluteFlux)
				&& !onCooldown) {
			detectedBeat = true;
			this.beatPredictionConfidence -= 0.05;
		}

		if(detectedBeat) {
			this.isBeat = true;
			this.lastBeatTime = now;
			this.beatCount++;
			this.detectedBeatCount++;
			this.expectedNextBeatTime = now + expectedInterval;

			this.beatTimestamps.push(now);
			if(this.beatTimestamps.length > this.maxBeatTimestamps) this.beatTimestamps.shift();

			if(this.beatTimestamps.length >= 2) {
				const lastInterval = this.beatTimestamps[this.beatTimestamps.length - 1]
					- this.beatTimestamps[this.beatTimestamps.length - 2];
				this.recentIntervals.push(lastInterval);
				if(this.recentIntervals.length > 16) this.recentIntervals.shift();

				if(this.recentIntervals.length >= 4) {
					const sorted = this.recentIntervals.slice().sort((a, b) => a - b);
					const median = sorted[sorted.length >> 1];
					let normalCount = 0, doubleCount = 0;
					for(const iv of this.recentIntervals) {
						if(Math.abs(iv - median) / median < 0.2) normalCount++;
						if(Math.abs(iv - median * 2) / (median * 2) < 0.2) doubleCount++;
					}
					const total = normalCount + doubleCount;
					if(total > 0) this.kickDensity = normalCount / total;
				}
			}

			this._updateBPM();

			this.recentBeatEnergies.push(bassFlux);
			if(this.recentBeatEnergies.length > 16) this.recentBeatEnergies.shift();

			if(this.recentBeatEnergies.length >= 4) {
				let sum = 0;
				for(const e of this.recentBeatEnergies) sum += e;
				const avg = sum / this.recentBeatEnergies.length;
				if(bassFlux > avg * 1.5 && this.downbeatCounter !== 0) this.downbeatCounter = 0;
			}

			// alternating-bass kick density heuristic
			if(this.recentBeatEnergies.length >= 8) {
				const sortedE = this.recentBeatEnergies.slice().sort((a, b) => a - b);
				const medianE = sortedE[sortedE.length >> 1];
				if(medianE > 0.001) {
					let strong = 0, weak = 0;
					for(const e of this.recentBeatEnergies) {
						if(e > medianE * 2.0) strong++;
						else if(e < medianE * 0.4) weak++;
					}
					const total = strong + weak;
					if(total >= 6 && strong >= 3 && weak >= 3) {
						this.kickDensity = strong / total;
					}
				}
			}

			this.beatInBar = this.downbeatCounter;
			this.isDownbeat = (this.beatInBar === 0);
			this.downbeatCounter = (this.downbeatCounter + 1) % 4;
		}

		// ODF for autocorrelation
		this.odfBuffer[this.odfIndex % this.odfBufferSize] = bassFlux + midFlux * 0.3;
		this.odfIndex++;

		// EMA the effective tick rate (autocorrelation needs this for lag→BPM)
		if(this.lastProcessTime > 0 && dt > 0 && dt < 0.2) {
			this.avgProcessDt = this.avgProcessDt * 0.9 + dt * 0.1;
		}
		this.lastProcessTime = now;

		this.framesSinceAutoCorr++;
		if(this.framesSinceAutoCorr >= this.autoCorrInterval && this.odfIndex >= 120) {
			this.framesSinceAutoCorr = 0;
			this._updateTempoFromAutoCorrelation();
		}

		this._resolveSubdivision();
	}

	_sumBand(start, end) {
		let sum = 0;
		for(let i = start; i < end; i++) sum += this.magnitudes[i];
		return sum;
	}

	_smooth(current, target) {
		const alpha = target > current ? this.attackAlpha : this.decayAlpha;
		return current + alpha * (target - current);
	}

	// Writes value into circular history at logical index, returns adaptive threshold
	// (mean over ±windowHalf window + offset). Mirrors Swift's modulo-wrap logic.
	_pushAndThreshold(history, logicalIndex, value) {
		const n = history.length;
		const histIdx = logicalIndex % n;
		history[histIdx] = value;
		const filledCount = Math.min(logicalIndex + 1, n);
		let sum = 0, count = 0;
		for(let offset = -this.fluxThresholdWindowHalf; offset <= this.fluxThresholdWindowHalf; offset++) {
			const idx = histIdx + offset;
			const wrapped = ((idx % filledCount) + filledCount) % filledCount;
			sum += history[wrapped];
			count++;
		}
		return (sum / count) + this.fluxThresholdOffset;
	}

	_computeTrebPeriodicity() {
		const filled = Math.min(this.trebFluxIndex, this.trebFluxHistory.length);
		if(filled < 16 || this.estimatedBPM <= 0) return 0;

		const effectiveFPS = 1.0 / this.avgProcessDt;
		const expectedPeriod = effectiveFPS * 60.0 / this.estimatedBPM;
		const lag = Math.round(expectedPeriod);
		if(lag < 2 || lag >= filled / 2) return 0;

		const histLen = this.trebFluxHistory.length;
		const startIdx = this.trebFluxIndex >= histLen ? (this.trebFluxIndex % histLen) : 0;
		const linear = new Float32Array(filled);
		let mean = 0;
		for(let i = 0; i < filled; i++) {
			const v = this.trebFluxHistory[(startIdx + i) % histLen];
			linear[i] = v;
			mean += v;
		}
		mean /= filled;
		for(let i = 0; i < filled; i++) linear[i] -= mean;

		let r0 = 0, rLag = 0;
		const n = filled - lag;
		if(n <= 0) return 0;
		for(let i = 0; i < filled; i++) r0 += linear[i] * linear[i];
		for(let i = 0; i < n; i++) rLag += linear[i] * linear[i + lag];

		if(r0 < 1e-10) return 0;
		return Math.max(0, Math.min(1.0, rLag / r0));
	}

	_updateBPM() {
		if(this.beatTimestamps.length < 4) return;

		const intervals = [];
		for(let i = 1; i < this.beatTimestamps.length; i++) {
			const iv = this.beatTimestamps[i] - this.beatTimestamps[i - 1];
			if(iv > 0.12 && iv < 2.0) intervals.push(iv);
		}
		if(intervals.length < 3) return;

		const sorted = intervals.slice().sort((a, b) => a - b);
		const fullMedian = sorted[sorted.length >> 1];

		const recentCount = Math.min(4, intervals.length);
		const recentSorted = intervals.slice(-recentCount).sort((a, b) => a - b);
		const recentMedian = recentSorted[recentSorted.length >> 1];

		const drift = Math.abs(recentMedian - fullMedian) / fullMedian;
		const useMedian = drift > 0.05 ? recentMedian : fullMedian;
		const newBPM = 60.0 / useMedian;

		if(this.estimatedBPM > 0) {
			const bpmDelta = Math.abs(newBPM - this.estimatedBPM) / this.estimatedBPM;
			if(bpmDelta <= 0.25) {
				const alpha = drift > 0.05 ? 0.7 : (intervals.length >= 8 ? 0.5 : 0.3);
				this.estimatedBPM = this.estimatedBPM * (1 - alpha) + newBPM * alpha;
			}
		} else {
			this.estimatedBPM = newBPM;
		}
	}

	_updateTempoFromAutoCorrelation() {
		const filled = Math.min(this.odfIndex, this.odfBufferSize);
		if(filled < 120) return;

		const startIdx = this.odfIndex >= this.odfBufferSize ? (this.odfIndex % this.odfBufferSize) : 0;
		const linear = new Float32Array(filled);
		let mean = 0;
		for(let i = 0; i < filled; i++) {
			const v = this.odfBuffer[(startIdx + i) % this.odfBufferSize];
			linear[i] = v;
			mean += v;
		}
		mean /= filled;
		for(let i = 0; i < filled; i++) linear[i] -= mean;

		const effectiveFPS = 1.0 / this.avgProcessDt;
		const minLag = Math.max(2, Math.floor(effectiveFPS * 60.0 / this.tempoMaxBPM));
		const maxLag = Math.min(filled - 1, Math.floor(effectiveFPS * 60.0 / this.tempoMinBPM));
		if(maxLag <= minLag) return;

		// decay existing histogram
		for(let i = 0; i < this.tempoHistogram.length; i++) {
			this.tempoHistogram[i] *= this.tempoHistDecay;
		}

		// raw autocorrelation at each lag
		const lagCount = maxLag - minLag + 1;
		const rawCorr = new Float32Array(lagCount);
		for(let lag = minLag; lag <= maxLag; lag++) {
			const n = filled - lag;
			if(n <= 0) continue;
			let corr = 0;
			for(let i = 0; i < n; i++) corr += linear[i] * linear[i + lag];
			const v = corr / n;
			rawCorr[lag - minLag] = v > 0 ? v : 0;
		}

		// comb-filter scoring across 4 harmonics, weighted by log-normal prior
		for(let bpm = this.tempoMinBPM; bpm <= this.tempoMaxBPM; bpm += 1) {
			const period = effectiveFPS * 60.0 / bpm;
			let score = 0, weight = 1.0;
			for(let h = 1; h <= 4; h++) {
				const lag = Math.round(period * h);
				const idx = lag - minLag;
				if(idx < 0 || idx >= lagCount) break;
				score += weight * rawCorr[idx];
				weight *= 0.5;
			}
			const logRatio = Math.log(bpm / this.priorCenterBPM);
			const prior = Math.exp(-logRatio * logRatio / (2.0 * this.priorLogSigma * this.priorLogSigma));
			const bin = bpm - this.tempoMinBPM;
			if(bin >= 0 && bin < this.tempoHistogram.length) {
				this.tempoHistogram[bin] += score * prior;
			}
		}

		// peak find
		let maxVal = 0, maxIdx = 0;
		for(let i = 0; i < this.tempoHistogram.length; i++) {
			if(this.tempoHistogram[i] > maxVal) {
				maxVal = this.tempoHistogram[i];
				maxIdx = i;
			}
		}
		if(maxVal <= 0) return;

		// octave disambiguation: prefer the higher tempo if beat intervals support it
		const doubleIdx = Math.floor((maxIdx + this.tempoMinBPM) * 2 - this.tempoMinBPM);
		if(doubleIdx >= 0 && doubleIdx < this.tempoHistogram.length) {
			const doubleVal = this.tempoHistogram[doubleIdx];
			const doubleBPM = doubleIdx + this.tempoMinBPM;
			const halfBPM = maxIdx + this.tempoMinBPM;

			let intervalSupportsDouble = false;
			if(this.beatTimestamps.length >= 6) {
				const ivs = [];
				for(let k = 1; k < this.beatTimestamps.length; k++) {
					const iv = this.beatTimestamps[k] - this.beatTimestamps[k - 1];
					if(iv > 0.12 && iv < 2.0) ivs.push(iv);
				}
				if(ivs.length > 0) {
					ivs.sort((a, b) => a - b);
					const medIV = ivs[ivs.length >> 1];
					const ivBPM = 60.0 / medIV;
					const errToDouble = Math.abs(ivBPM - doubleBPM) / doubleBPM;
					const errToHalf = Math.abs(ivBPM - halfBPM) / halfBPM;
					intervalSupportsDouble = errToDouble < errToHalf;
				}
			}
			if(doubleVal > maxVal * 0.4 && intervalSupportsDouble) {
				maxIdx = doubleIdx;
				maxVal = doubleVal;
			}
		}

		let bestBPM = maxIdx + this.tempoMinBPM;
		if(maxIdx > 0 && maxIdx < this.tempoHistogram.length - 1) {
			const a = this.tempoHistogram[maxIdx - 1];
			const b = this.tempoHistogram[maxIdx];
			const c = this.tempoHistogram[maxIdx + 1];
			const denom = a - 2 * b + c;
			if(Math.abs(denom) > 1e-6) {
				bestBPM = maxIdx + this.tempoMinBPM + 0.5 * (a - c) / denom;
			}
		}

		if(this.estimatedBPM > 0 && bestBPM > 0) {
			const bpmDelta = Math.abs(bestBPM - this.estimatedBPM) / this.estimatedBPM;
			const alpha = bpmDelta < 0.05 ? 0.4 : (bpmDelta < 0.15 ? 0.2 : 0.1);
			this.estimatedBPM = this.estimatedBPM * (1 - alpha) + bestBPM * alpha;
		} else if(bestBPM > 0) {
			this.estimatedBPM = bestBPM;
		}

		this._resolveSubdivision();
	}

	_resolveSubdivision() {
		if(this.estimatedBPM <= 0) return;
		if(this.recentIntervals.length < 6) return;

		const halfBPM = this.estimatedBPM / 2;
		const doubleBPM = this.estimatedBPM * 2;
		const fullEnergy = this._histogramEnergy(this.estimatedBPM);
		const halfEnergy = this._histogramEnergy(halfBPM);
		const doubleEnergy = this._histogramEnergy(doubleBPM);

		if(this.estimatedBPM > 160 && halfBPM >= 50) {
			if(halfEnergy > fullEnergy * 0.3 && this.kickDensity < 0.7 && this.snareProminence > 0.2) {
				this.estimatedBPM = halfBPM;
			}
		} else if(this.estimatedBPM < 60 && doubleBPM <= 200) {
			if(doubleEnergy > fullEnergy * 0.3) this.estimatedBPM = doubleBPM;
		} else if(this.estimatedBPM > 130) {
			if(halfBPM >= 50 && halfEnergy > fullEnergy * 0.5
					&& this.kickDensity < 0.6 && this.snareProminence > 0.2) {
				this.estimatedBPM = halfBPM;
			}
		}
	}

	_histogramEnergy(bpm) {
		const idx = Math.floor(bpm - this.tempoMinBPM);
		if(idx < 0 || idx >= this.tempoHistogram.length) return 0;
		let energy = 0;
		for(let offset = -2; offset <= 2; offset++) {
			const i = idx + offset;
			if(i >= 0 && i < this.tempoHistogram.length) {
				if(this.tempoHistogram[i] > energy) energy = this.tempoHistogram[i];
			}
		}
		return energy;
	}
}
