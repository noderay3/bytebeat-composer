// DanceEngineV2 — "Groove v2" — phase-locked dance engine
// Port of ProjectMFramework/DanceEngineV2.swift
// V1 plus 4 improvements:
//   1. Phase velocity micro-modulation (ease in/out within bob)
//   2. Beat emphasis (downbeat differentiation)
//   3. Energy-responsive animation speed
//   4. Enhanced anticipation (earlier, ramped pre-correction)

const FRAME_COUNT = 264;
const NATIVE_FPS = 30;
const NATIVE_BPM = 123;
const BEAT_KEYFRAMES = [0, 8, 16, 24, 30, 38, 46, 54, 60, 68, 74, 82, 90, 96, 104, 112, 118, 124, 132, 138, 146, 152, 160, 168, 176, 182, 190, 196, 204, 212, 220, 226, 236, 244, 250, 256];
const LEFT_BEATS = new Set([8, 24, 38, 54, 68, 82, 96, 112, 124, 138, 152, 168, 182, 196, 212, 226, 244, 256]);
const RIGHT_BEATS = new Set([0, 16, 30, 46, 60, 74, 90, 104, 118, 132, 146, 160, 176, 190, 204, 220, 236, 250]);
const ALL_KEYFRAMES = new Set(BEAT_KEYFRAMES);
const SORTED_KEYFRAMES = BEAT_KEYFRAMES.slice().sort((a, b) => a - b);

// Positive-result modulo
function mod(x, n) {
	const r = x % n;
	return r < 0 ? r + n : r;
}

// CatMeta.bobPosition: -1 at right keyframe, +1 at left, cosine between
export function bobPosition(phase) {
	const kf = BEAT_KEYFRAMES;
	const p = mod(phase, FRAME_COUNT);

	// Binary search for prevIdx such that kf[prevIdx] <= p
	let lo = 0, hi = kf.length - 1;
	while(lo < hi) {
		const m = (lo + hi + 1) >> 1;
		if(kf[m] <= p) lo = m; else hi = m - 1;
	}
	const prevIdx = lo;
	const nextIdx = (prevIdx + 1) % kf.length;

	const prevFrame = kf[prevIdx];
	const nextFrame = nextIdx === 0 ? FRAME_COUNT + kf[0] : kf[nextIdx];
	const span = nextFrame - prevFrame;
	const t = span > 0 ? (p - prevFrame) / span : 0;

	const prevIsRight = RIGHT_BEATS.has(kf[prevIdx]);
	const prevVal = prevIsRight ? -1 : 1;
	const nextVal = -prevVal;

	const cosT = (1 - Math.cos(Math.PI * t)) / 2;
	return prevVal + (nextVal - prevVal) * cosT;
}

// StyleInference.infer — auto-detect style from audio features.
// Returns a StyleParams object: { perceivedBPMMultiplier, beatSourceMidWeight,
// pulseMaintenanceSeconds, idleConfidenceThreshold, minBobBPM, maxBobBPM }
export function inferStyle(bpm, kickDensity, snareProminence, bassEnergy, confidence) {
	const fourOnTheFloor = {
		perceivedBPMMultiplier: 1.0,
		beatSourceMidWeight: 0.0,
		pulseMaintenanceSeconds: 10.0,
		idleConfidenceThreshold: 0.2,
		minBobBPM: 40, maxBobBPM: 200
	};
	const halfTimeBass = {
		perceivedBPMMultiplier: 0.5,
		beatSourceMidWeight: 0.0,
		pulseMaintenanceSeconds: 12.0,
		idleConfidenceThreshold: 0.3,
		minBobBPM: 40, maxBobBPM: 200
	};
	const halfTimeSnare = {
		perceivedBPMMultiplier: 0.5,
		beatSourceMidWeight: 0.6,
		pulseMaintenanceSeconds: 5.0,
		idleConfidenceThreshold: 0.3,
		minBobBPM: 40, maxBobBPM: 200
	};
	const ambient = {
		perceivedBPMMultiplier: 1.0,
		beatSourceMidWeight: 0.0,
		pulseMaintenanceSeconds: 0.0,
		idleConfidenceThreshold: 0.7,
		minBobBPM: 40, maxBobBPM: 200
	};

	let params = fourOnTheFloor;

	if(bpm > 155) {
		if(kickDensity < 0.7 || snareProminence > 0.4) {
			params = { ...fourOnTheFloor, perceivedBPMMultiplier: 0.5, pulseMaintenanceSeconds: 12.0 };
		}
	} else if(bpm > 125) {
		if(kickDensity < 0.6 && snareProminence > 0.5) {
			params = halfTimeSnare;
		} else if(kickDensity < 0.7) {
			params = halfTimeBass;
		}
	} else if(bpm < 70 && confidence < 0.3) {
		params = ambient;
	}

	return params;
}

function defaultStyleParams() {
	return {
		perceivedBPMMultiplier: 1.0,
		beatSourceMidWeight: 0.0,
		pulseMaintenanceSeconds: 8.0,
		idleConfidenceThreshold: 0.3,
		minBobBPM: 50, maxBobBPM: 160
	};
}

export class DanceEngineV2 {
	constructor() {
		this.phase = 0;
		this.phaseVelocity = 15;
		this.danceTempo = 0;
		this.tempoConfidence = 0;
		this.pendingCorrection = 0;
		this.displayedFrame = 0;

		this.correctionDecay = 0.70;

		this.framesSinceLastBeat = 999;
		this.silenceThreshold = 180;

		this.driftHistory = [];
		this.driftHistoryMax = 8;

		this.vibeIntensityMultiplier = 1.0;
		this.latencyCompensation = 0.040;
		this.beatReactivity = 0.7;

		this.styleParams = defaultStyleParams();

		this._breakdownTimer = 0;
		this._recentPeakEnergy = 0;

		this.currentScale = 1.0;
		this._scaleVelocity = 0;

		this.danceEnergy = 0;
		this._bassHitEnergy = 0;

		this._grooveEnabled = true;
		this._baseVelocity = 15;
		this._energySmoothed = 0;
		this._amplitudeEnvelope = 0.5;
		this._shimmerPhase = 0;
		this._lastBeatBassEnergy = 0;

		this.keyframeCrossings = [];
		this._prevFrame = -1;

		this.recentBeats = [];
		this.recentErrors = [];

		this.velocityHistory = [];
		this.energyHistory = [];
		this.beatResponseHistory = [];

		this._nextExpectedBeatTime = 0;
		this._lastBeatTime = 0;
		this._beatPredictionActive = false;
		this._predictionHits = 0;
		this._predictionMisses = 0;
		this._predictiveCorrectionApplied = false;
	}

	reset() {
		this.phase = 0; this.phaseVelocity = 15; this.danceTempo = 0; this.tempoConfidence = 0;
		this.pendingCorrection = 0; this.displayedFrame = 0; this.framesSinceLastBeat = 999;
		this.driftHistory = []; this.currentScale = 1.0; this._scaleVelocity = 0;
		this.danceEnergy = 0; this._bassHitEnergy = 0;
		this._baseVelocity = 15; this._energySmoothed = 0; this._amplitudeEnvelope = 0.5;
		this._shimmerPhase = 0; this._lastBeatBassEnergy = 0;
		this.keyframeCrossings = []; this.recentBeats = []; this.recentErrors = [];
		this.velocityHistory = []; this.energyHistory = []; this.beatResponseHistory = [];
		this._nextExpectedBeatTime = 0; this._lastBeatTime = 0; this._beatPredictionActive = false;
		this._predictionHits = 0; this._predictionMisses = 0; this._predictiveCorrectionApplied = false;
		this._breakdownTimer = 0; this._recentPeakEnergy = 0;
		this._prevFrame = -1;
	}

	get isPredicting() { return this._beatPredictionActive; }
	get predictionAccuracy() {
		const total = this._predictionHits + this._predictionMisses;
		return total > 0 ? this._predictionHits / total : 0;
	}

	nearestKeyframe(frame) {
		if(BEAT_KEYFRAMES.length === 0) return null;
		const fc = FRAME_COUNT;
		let bestDist = fc;
		let bestFrame = 0;
		for(const kf of BEAT_KEYFRAMES) {
			const fwd = kf >= frame ? kf - frame : kf + fc - frame;
			const bwd = frame >= kf ? frame - kf : frame + fc - kf;
			const dist = Math.min(fwd, bwd);
			if(dist < bestDist) { bestDist = dist; bestFrame = kf; }
		}
		return bestFrame;
	}

	// Nearest RIGHT keyframe (beats land on right bobs)
	nearestRightKeyframe(frame) {
		const fc = FRAME_COUNT;
		let bestDist = fc;
		let bestFrame = 0;
		for(const kf of RIGHT_BEATS) {
			const fwd = kf >= frame ? kf - frame : kf + fc - frame;
			const bwd = frame >= kf ? frame - kf : frame + fc - kf;
			const dist = Math.min(fwd, bwd);
			if(dist < bestDist) { bestDist = dist; bestFrame = kf; }
		}
		return bestDist < fc ? bestFrame : null;
	}

	nextRightKeyframe(frame) {
		const fc = FRAME_COUNT;
		let bestDist = fc;
		let bestFrame = 0;
		for(const kf of RIGHT_BEATS) {
			const fwd = kf >= frame ? kf - frame : kf + fc - frame;
			if(fwd > 0.5 && fwd < bestDist) {
				bestDist = fwd;
				bestFrame = kf;
			}
		}
		return bestDist < fc ? bestFrame : null;
	}

	nextKeyframe(frame) {
		if(BEAT_KEYFRAMES.length === 0) return null;
		const fc = FRAME_COUNT;
		let bestDist = fc;
		let bestFrame = 0;
		for(const kf of BEAT_KEYFRAMES) {
			const fwd = kf >= frame ? kf - frame : kf + fc - frame;
			if(fwd > 0.5 && fwd < bestDist) {
				bestDist = fwd;
				bestFrame = kf;
			}
		}
		if(bestDist >= fc) return BEAT_KEYFRAMES[0];
		return bestFrame;
	}

	// Ground truth mode — explicit beat signal, no groove modulation
	tickWithBeat(dt, isBeat, bpm, bassEnergy, currentTime) {
		const fc = FRAME_COUNT;

		if(isBeat) this.framesSinceLastBeat = 0; else this.framesSinceLastBeat++;
		if(this.framesSinceLastBeat > this.silenceThreshold) {
			this.phaseVelocity *= 0.95;
			if(this.phaseVelocity < 0.5) this.phaseVelocity = 0;
		}

		this.danceTempo = bpm;
		this.tempoConfidence = 1.0;

		const tempoRatio = bpm > 0 ? bpm / NATIVE_BPM : 0;
		const targetVelocity = NATIVE_FPS * tempoRatio;

		this.phaseVelocity = targetVelocity;
		this.phaseVelocity = Math.max(0, Math.min(this.phaseVelocity, NATIVE_FPS * 3));

		const correction = this.pendingCorrection * this.correctionDecay;
		this.pendingCorrection -= correction;
		if(Math.abs(this.pendingCorrection) < 0.1) this.pendingCorrection = 0;
		this.phase = mod(this.phase + this.phaseVelocity * dt + correction, fc);

		if(isBeat) {
			const target = this.nearestRightKeyframe(this.phase);
			if(target !== null) {
				let error = target - this.phase;
				if(error > fc / 2) error -= fc;
				if(error < -fc / 2) error += fc;
				const snapStrength = this._grooveEnabled ? (0.4 + bassEnergy * 0.3) : 0.6;
				this.pendingCorrection += error * snapStrength * this.beatReactivity;
				this._bassHitEnergy = 0.5 + bassEnergy * 0.5;
				this.recentErrors.push({ time: currentTime, error });
			}
			this.recentBeats.push(currentTime);
		}

		this.currentScale = 1.0;
		this.displayedFrame = mod(Math.trunc(this.phase), FRAME_COUNT);

		for(const kf of BEAT_KEYFRAMES) {
			if(LEFT_BEATS.has(kf) && this.displayedFrame === kf) {
				this.keyframeCrossings.push({ time: currentTime, frame: kf, side: 'L' });
			} else if(RIGHT_BEATS.has(kf) && this.displayedFrame === kf) {
				this.keyframeCrossings.push({ time: currentTime, frame: kf, side: 'R' });
			}
		}

		const cutoff = currentTime - 30;
		this.recentBeats = this.recentBeats.filter(t => t >= cutoff);
		this.recentErrors = this.recentErrors.filter(e => e.time >= cutoff);
		this.keyframeCrossings = this.keyframeCrossings.filter(k => k.time >= cutoff);
	}

	// Main entry — identical signature to V1
	tick(dt, detector, now) {
		const fc = FRAME_COUNT;

		const isBeat = !!detector.isBeat;
		const estimatedBPM = detector.estimatedBPM || 0;
		const bassEnergy = detector.bassEnergy || 0;
		const midEnergy = detector.midEnergy || 0;
		const trebEnergy = detector.trebEnergy || 0;
		const beatInBar = detector.beatInBar | 0;

		// 1. SILENCE DETECTION
		if(isBeat) this.framesSinceLastBeat = 0; else this.framesSinceLastBeat++;
		if(this.framesSinceLastBeat > this.silenceThreshold) {
			this.phaseVelocity *= 0.95;
			if(this.phaseVelocity < 0.5) this.phaseVelocity = 0;
			if(this.framesSinceLastBeat > 600) { this.danceTempo = 0; this.tempoConfidence = 0; }
		}

		// 2. FLYWHEEL TEMPO UPDATE
		const detectedBPM = estimatedBPM;
		if(detectedBPM > 30 && detectedBPM < 300 && this.framesSinceLastBeat < this.silenceThreshold) {
			if(this.danceTempo === 0) {
				this.danceTempo = detectedBPM; this.tempoConfidence = 0.3;
			} else {
				const bpmDiff = Math.abs(detectedBPM - this.danceTempo) / this.danceTempo;
				const signedError = detectedBPM - this.danceTempo;
				const acquiring = this.tempoConfidence < 0.5;
				this.driftHistory.push(signedError > 0 ? 1 : -1);
				if(this.driftHistory.length > this.driftHistoryMax) this.driftHistory.shift();
				const driftSum = this.driftHistory.reduce((a, b) => a + b, 0);
				const drifting = this.driftHistory.length >= 4 && Math.abs(driftSum) >= this.driftHistory.length - 1;
				const driftMul = drifting ? 50.0 : 1.0;
				if(bpmDiff < 0.03) {
					this.tempoConfidence = Math.min(1.0, this.tempoConfidence + 0.01);
					this.danceTempo += signedError * (acquiring ? 0.05 : 0.005) * driftMul;
				} else if(bpmDiff < 0.10) {
					this.tempoConfidence = Math.min(1.0, this.tempoConfidence + 0.003);
					this.danceTempo += signedError * (acquiring ? 0.08 : 0.008) * driftMul;
				} else if(bpmDiff < 0.25) {
					this.danceTempo += signedError * (acquiring ? 0.05 : 0.005) * driftMul;
					this.tempoConfidence = Math.max(0, this.tempoConfidence - 0.005);
				} else {
					this.tempoConfidence = Math.max(0, this.tempoConfidence - 0.02);
					if(this.tempoConfidence < 0.05) this.danceTempo += signedError * 0.08;
				}
			}
		}

		// 3. PHASE VELOCITY
		const perceivedBPM = this.danceTempo * this.styleParams.perceivedBPMMultiplier;
		let clampedBPM = perceivedBPM;
		if(this.styleParams.perceivedBPMMultiplier >= 1.0) {
			if(clampedBPM > 200) clampedBPM /= 2;
			if(clampedBPM < 40 && clampedBPM > 0) clampedBPM *= 2;
		}

		const tempoRatio = clampedBPM > 0 ? clampedBPM / NATIVE_BPM : 0;

		// IMPROVEMENT 3: energy-responsive animation speed (+/-5% per energy)
		const smoothedEnergy = this.danceEnergy;
		const energyScale = 1.0 + 0.05 * (smoothedEnergy - 0.5);
		const clampedEnergyScale = Math.max(0.95, Math.min(1.05, energyScale));
		this._baseVelocity = NATIVE_FPS * tempoRatio * clampedEnergyScale;

		const targetVelocity = this._baseVelocity;

		const recovering = this.phaseVelocity < targetVelocity * 0.5 && targetVelocity > 1;
		const velAlpha = recovering ? 0.2 : (this.tempoConfidence < 0.5 ? 0.08 : 0.015);
		this.phaseVelocity += (targetVelocity - this.phaseVelocity) * velAlpha;
		this.phaseVelocity = Math.max(0, Math.min(this.phaseVelocity, NATIVE_FPS * 3));

		// IMPROVEMENT 1: phase velocity micro-modulation (3% sinusoidal wiggle per segment)
		const modulationAmplitude = 0.03;
		let prevKF = SORTED_KEYFRAMES[SORTED_KEYFRAMES.length - 1];
		let nextKF = SORTED_KEYFRAMES[0];
		const firstKF = SORTED_KEYFRAMES[0];
		for(const kf of SORTED_KEYFRAMES) {
			if(kf <= this.phase) prevKF = kf;
			if(kf > this.phase && nextKF === firstKF) nextKF = kf;
		}
		let segmentLength = nextKF - prevKF;
		if(segmentLength <= 0) segmentLength += FRAME_COUNT;
		let posInSegment = this.phase - prevKF;
		if(posInSegment < 0) posInSegment += FRAME_COUNT;
		const tSeg = posInSegment / segmentLength;
		const modulation = 1.0 + modulationAmplitude * Math.sin(Math.PI * tSeg);
		const modulatedVelocity = this.phaseVelocity * modulation;

		// ADVANCE PHASE
		const correction = this.pendingCorrection * this.correctionDecay;
		this.pendingCorrection -= correction;
		if(Math.abs(this.pendingCorrection) < 0.1) this.pendingCorrection = 0;
		this.phase = mod(this.phase + modulatedVelocity * dt + correction, fc);

		// IMPROVEMENT 4: enhanced anticipation — 100ms ramped pre-correction window
		if(this._beatPredictionActive && this.danceTempo > 0) {
			const timeUntilPredicted = this._nextExpectedBeatTime - now;
			if(timeUntilPredicted <= 0.100 && timeUntilPredicted > -0.010 && !this._predictiveCorrectionApplied) {
				const latencyFrames = this.phaseVelocity * this.latencyCompensation;
				let lookupPhase = this.phase - latencyFrames;
				if(lookupPhase < 0) lookupPhase += fc;
				const target = this.nearestRightKeyframe(lookupPhase);
				if(target !== null) {
					let error = target - lookupPhase;
					if(error > fc / 2) error -= fc;
					if(error < -fc / 2) error += fc;
					// proximity: 0 at 100ms out, 1 at the beat itself
					const proximity = 1.0 - (timeUntilPredicted / 0.100);
					const preSnapStrength = 0.30 * proximity * (this.tempoConfidence > 0.5 ? 0.5 : 0.7);
					this.pendingCorrection += error * preSnapStrength * this.beatReactivity;
				}
				if(timeUntilPredicted <= 0.010) this._predictiveCorrectionApplied = true;
			}
		}

		// 4. BEAT-TRIGGERED PHASE CORRECTION
		if(isBeat) {
			const latencyFrames = this.phaseVelocity * this.latencyCompensation;
			let lookupPhase = this.phase - latencyFrames;
			if(lookupPhase < 0) lookupPhase += fc;
			const target = this.nearestRightKeyframe(lookupPhase);
			if(target !== null) {
				let error = target - lookupPhase;
				if(error > fc / 2) error -= fc;
				if(error < -fc / 2) error += fc;

				let scalePulse;
				if(this._grooveEnabled) {
					this._lastBeatBassEnergy = bassEnergy;
					scalePulse = 0.06 + bassEnergy * 0.16;
					this.beatResponseHistory.push({
						beatStrength: bassEnergy,
						correctionMag: Math.abs(error),
						scalePulse
					});
				} else {
					scalePulse = 0.12 + bassEnergy * 0.08;
				}

				// IMPROVEMENT 2: beat emphasis — downbeats snap harder than offbeats
				let emphasisMultiplier;
				switch(beatInBar) {
					case 0: emphasisMultiplier = 1.3; break;
					case 2: emphasisMultiplier = 1.1; break;
					default: emphasisMultiplier = 0.9;
				}
				const avgSpacing = fc / BEAT_KEYFRAMES.length;
				const maxDirectSnapError = avgSpacing * emphasisMultiplier;

				if(Math.abs(error) < maxDirectSnapError) {
					this.phase = mod(this.phase + error, fc);
					this.pendingCorrection = 0;
				} else {
					const snapStrength = (this.tempoConfidence > 0.5 ? 0.6 : 0.8) * emphasisMultiplier;
					this.pendingCorrection += error * snapStrength * this.beatReactivity;
				}
				this.recentErrors.push({ time: now, error });
				this._bassHitEnergy = 0.5 + bassEnergy * 0.5;
			}
			this.recentBeats.push(now);

			if(this._beatPredictionActive && this._nextExpectedBeatTime > 0) {
				const predictionError = Math.abs(now - this._nextExpectedBeatTime);
				if(predictionError < 0.050) this._predictionHits++; else this._predictionMisses++;
				if(this._predictionMisses > this._predictionHits) this._beatPredictionActive = false;
			}

			this._lastBeatTime = now;
			const beatPeriod = 60.0 / this.danceTempo;
			this._nextExpectedBeatTime = now + beatPeriod;
			this._predictiveCorrectionApplied = false;

			if(!this._beatPredictionActive && this.tempoConfidence > 0.4 && this.recentBeats.length >= 4) {
				this._beatPredictionActive = true;
				this._predictionHits = 0;
				this._predictionMisses = 0;
			}
		}

		// 5. ENERGY
		const targetEnergy = bassEnergy * 0.5 + midEnergy * 0.3 + trebEnergy * 0.2;
		this.danceEnergy += (targetEnergy - this.danceEnergy) * 0.08;
		this._bassHitEnergy *= 0.92;

		if(this._grooveEnabled) {
			this._energySmoothed += (targetEnergy - this._energySmoothed) * 0.02;
			this._amplitudeEnvelope = Math.min(1.0, this._energySmoothed * 2.0);
			const shimmerFreq = 12.0;
			this._shimmerPhase += shimmerFreq * dt * 2 * Math.PI;
			if(this._shimmerPhase > 2 * Math.PI) this._shimmerPhase -= 2 * Math.PI;
		}

		// 5b. BREAKDOWN DETECTION
		const currentEnergy = bassEnergy + midEnergy * 0.5;
		if(currentEnergy < this._recentPeakEnergy * 0.2 && this._recentPeakEnergy > 0.1) {
			this._breakdownTimer += dt;
			const maintenanceLimit = this.styleParams.pulseMaintenanceSeconds;
			if(this._breakdownTimer > maintenanceLimit && maintenanceLimit > 0) {
				this.phaseVelocity *= 0.95;
			}
		} else {
			this._breakdownTimer = 0;
			this._recentPeakEnergy = Math.max(this._recentPeakEnergy * 0.999, currentEnergy);
		}

		this.currentScale = 1.0;

		// Frame + keyframe-crossing tracking
		this.displayedFrame = mod(Math.trunc(this.phase), FRAME_COUNT);
		if(this._prevFrame >= 0 && this.displayedFrame !== this._prevFrame) {
			let traversed;
			if(this.displayedFrame > this._prevFrame) {
				traversed = [];
				for(let f = this._prevFrame + 1; f <= this.displayedFrame; f++) traversed.push(f);
			} else {
				traversed = [];
				for(let f = this._prevFrame + 1; f < FRAME_COUNT; f++) traversed.push(f);
				for(let f = 0; f <= this.displayedFrame; f++) traversed.push(f);
			}
			for(const f of traversed) {
				if(ALL_KEYFRAMES.has(f)) {
					const side = LEFT_BEATS.has(f) ? 'L' : RIGHT_BEATS.has(f) ? 'R' : '?';
					this.keyframeCrossings.push({ time: now, frame: f, side });
				}
			}
		}
		this._prevFrame = this.displayedFrame;

		this.velocityHistory.push(this.phaseVelocity);
		this.energyHistory.push(bassEnergy);

		const cutoff = now - 30;
		this.recentBeats = this.recentBeats.filter(t => t >= cutoff);
		this.recentErrors = this.recentErrors.filter(e => e.time >= cutoff);
		this.keyframeCrossings = this.keyframeCrossings.filter(k => k.time >= cutoff);
		if(this.velocityHistory.length > 1800) this.velocityHistory.splice(0, this.velocityHistory.length - 1800);
		if(this.energyHistory.length > 1800) this.energyHistory.splice(0, this.energyHistory.length - 1800);
		if(this.beatResponseHistory.length > 200) this.beatResponseHistory.splice(0, this.beatResponseHistory.length - 200);
	}
}

export const CAT_META = {
	FRAME_COUNT, NATIVE_FPS, NATIVE_BPM,
	BEAT_KEYFRAMES, LEFT_BEATS, RIGHT_BEATS, ALL_KEYFRAMES
};
