// DanceEngineV3 — Expressive v3
// Phase-locked dance engine with style profiles, vibe drift, spring overshoot,
// and a musical-structure state machine on top of V2's groove dynamics.
//
// Web port of /Users/ray/claude/projectM/ProjectMFramework/DanceEngineV3.swift
//
// Drop-in interface: tick(dt, detector, now). Detector is duck-typed:
//   { isBeat, estimatedBPM, bassEnergy, midEnergy, trebEnergy,
//     kickDensity, snareProminence, beatInBar }

const FRAME_COUNT = 264;
const NATIVE_FPS = 30;
const NATIVE_BPM = 123;

const BEAT_KEYFRAMES = [
	0, 8, 16, 24, 30, 38, 46, 54, 60, 68, 74, 82,
	90, 96, 104, 112, 118, 124, 132, 138, 146, 152,
	160, 168, 176, 182, 190, 196, 204, 212, 220, 226,
	236, 244, 250, 256,
];

const LEFT_BEATS = new Set([
	8, 24, 38, 54, 68, 82, 96, 112,
	124, 138, 152, 168, 182, 196, 212, 226, 244, 256,
]);

const RIGHT_BEATS = new Set([
	0, 16, 30, 46, 60, 74, 90, 104,
	118, 132, 146, 160, 176, 190, 204, 220, 236, 250,
]);

const ALL_KEYFRAMES = new Set(BEAT_KEYFRAMES);

const SORTED_KFS = BEAT_KEYFRAMES.slice().sort((a, b) => a - b);
const FIRST_KF = SORTED_KFS[0];
const LAST_KF = SORTED_KFS[SORTED_KFS.length - 1];
const AVG_KF_SPACING = FRAME_COUNT / BEAT_KEYFRAMES.length;

// Positive-normalized modulo (matches Swift's truncatingRemainder + wrap)
function pmod(x, m) {
	const r = x % m;
	return r < 0 ? r + m : r;
}

// Default style params (from StyleInference.swift fourOnTheFloor)
function defaultStyleParams() {
	return {
		perceivedBPMMultiplier: 1.0,
		beatSourceMidWeight: 0.0,
		pulseMaintenanceSeconds: 10.0,
		idleConfidenceThreshold: 0.2,
		minBobBPM: 40,
		maxBobBPM: 200,
	};
}

// Auto-infer style from features. Matches StyleInference.swift lines 74-102.
export function inferStyle(detectedBPM, kickDensity, snareProminence, bassEnergy, confidence) {
	const params = defaultStyleParams();
	if(detectedBPM > 155) {
		if(kickDensity < 0.7 || snareProminence > 0.4) {
			params.perceivedBPMMultiplier = 0.5;
			params.pulseMaintenanceSeconds = 12.0;
		}
	} else if(detectedBPM > 125) {
		if(kickDensity < 0.6 && snareProminence > 0.5) {
			// trap half-time (snare-driven)
			params.perceivedBPMMultiplier = 0.5;
			params.beatSourceMidWeight = 0.6;
			params.pulseMaintenanceSeconds = 5.0;
			params.idleConfidenceThreshold = 0.3;
		} else if(kickDensity < 0.7) {
			// dubstep half-time (bass-driven)
			params.perceivedBPMMultiplier = 0.5;
			params.pulseMaintenanceSeconds = 12.0;
			params.idleConfidenceThreshold = 0.3;
		}
	} else if(detectedBPM < 70 && confidence < 0.3) {
		params.pulseMaintenanceSeconds = 0.0;
		params.idleConfidenceThreshold = 0.7;
	}
	return params;
}

// Cosine-interp bob position: -1 at right keyframe, +1 at left (port of CatMeta.bobPosition)
export function bobPosition(phase) {
	const p = pmod(phase, FRAME_COUNT);
	// Binary search for prev keyframe
	let lo = 0, hi = SORTED_KFS.length - 1;
	while(lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if(SORTED_KFS[mid] <= p) lo = mid; else hi = mid - 1;
	}
	const prevIdx = lo;
	const nextIdx = (prevIdx + 1) % SORTED_KFS.length;
	const prevFrame = SORTED_KFS[prevIdx];
	let nextFrame = SORTED_KFS[nextIdx];
	if(nextIdx === 0) nextFrame = FRAME_COUNT + SORTED_KFS[0];
	const span = nextFrame - prevFrame;
	const t = span > 0 ? (p - prevFrame) / span : 0;
	const prevIsRight = RIGHT_BEATS.has(SORTED_KFS[prevIdx]);
	const prevVal = prevIsRight ? -1 : 1;
	const nextVal = -prevVal;
	const cosT = (1 - Math.cos(Math.PI * t)) / 2;
	return prevVal + (nextVal - prevVal) * cosT;
}

export class DanceEngineV3 {
	constructor() {
		this.phase = 0;
		this.phaseVelocity = 15;
		this.danceTempo = 0;
		this.tempoConfidence = 0;
		this.pendingCorrection = 0;
		this.displayedFrame = 0;

		this._correctionDecay = 0.70;

		this.framesSinceLastBeat = 999;
		this._silenceThreshold = 180;

		this._driftHistory = [];
		this._driftHistoryMax = 8;

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

		this._velocityHistory = [];
		this._energyHistory = [];
		this._beatResponseHistory = [];

		this._nextExpectedBeatTime = 0;
		this._lastBeatTime = 0;
		this._beatPredictionActive = false;
		this._predictionHits = 0;
		this._predictionMisses = 0;
		this._predictiveCorrectionApplied = false;

		// V3 Feature 1: style-specific velocity profiles
		this.activeProfile = 'smooth';

		// V3 Feature 2: vibe drift LFO
		this._vibeDriftPhase = 0;
		this._vibeDriftPeriod = 6.0;
		this._vibeDriftAmplitude = 0;

		// V3 Feature 3: overshoot spring
		this._springVelocity = 0;
		this._springDamping = 0.85;

		// V3 Feature 4: musical state machine
		this.musicalState = 'steady';
		this._prevEnergy = 0;
		this._energyRiseCount = 0;
		this._dropFrameCount = 0;
	}

	reset() {
		this.phase = 0; this.phaseVelocity = 15; this.danceTempo = 0; this.tempoConfidence = 0;
		this.pendingCorrection = 0; this.displayedFrame = 0; this.framesSinceLastBeat = 999;
		this._driftHistory = []; this.currentScale = 1.0; this._scaleVelocity = 0;
		this.danceEnergy = 0; this._bassHitEnergy = 0;
		this._baseVelocity = 15; this._energySmoothed = 0; this._amplitudeEnvelope = 0.5;
		this._shimmerPhase = 0; this._lastBeatBassEnergy = 0;
		this.keyframeCrossings = []; this.recentBeats = []; this.recentErrors = [];
		this._velocityHistory = []; this._energyHistory = []; this._beatResponseHistory = [];
		this._nextExpectedBeatTime = 0; this._lastBeatTime = 0; this._beatPredictionActive = false;
		this._predictionHits = 0; this._predictionMisses = 0; this._predictiveCorrectionApplied = false;
		this._breakdownTimer = 0; this._recentPeakEnergy = 0;
		this._vibeDriftPhase = 0; this._vibeDriftAmplitude = 0;
		this._springVelocity = 0;
		this.musicalState = 'steady'; this._prevEnergy = 0; this._energyRiseCount = 0; this._dropFrameCount = 0;
		this.activeProfile = 'smooth';
		this._prevFrame = -1;
	}

	nearestKeyframe(frame) {
		if(BEAT_KEYFRAMES.length === 0) return null;
		let bestDist = FRAME_COUNT;
		let bestFrame = 0;
		for(const kf of BEAT_KEYFRAMES) {
			const fwd = kf >= frame ? kf - frame : kf + FRAME_COUNT - frame;
			const bwd = frame >= kf ? frame - kf : frame + FRAME_COUNT - kf;
			const dist = Math.min(fwd, bwd);
			if(dist < bestDist) { bestDist = dist; bestFrame = kf; }
		}
		return bestFrame;
	}

	nearestRightKeyframe(frame) {
		let bestDist = FRAME_COUNT;
		let bestFrame = 0;
		for(const kf of RIGHT_BEATS) {
			const fwd = kf >= frame ? kf - frame : kf + FRAME_COUNT - frame;
			const bwd = frame >= kf ? frame - kf : frame + FRAME_COUNT - kf;
			const dist = Math.min(fwd, bwd);
			if(dist < bestDist) { bestDist = dist; bestFrame = kf; }
		}
		return bestDist < FRAME_COUNT ? bestFrame : null;
	}

	tick(dt, detector, now) {
		const isBeat = !!detector.isBeat;
		const estimatedBPM = detector.estimatedBPM ?? 0;
		const bassEnergy = detector.bassEnergy ?? 0;
		const midEnergy = detector.midEnergy ?? 0;
		const trebEnergy = detector.trebEnergy ?? 0;
		const beatInBar = detector.beatInBar ?? -1;

		// 1. SILENCE DETECTION
		if(isBeat) this.framesSinceLastBeat = 0;
		else this.framesSinceLastBeat += 1;
		if(this.framesSinceLastBeat > this._silenceThreshold) {
			this.phaseVelocity *= 0.95;
			if(this.phaseVelocity < 0.5) this.phaseVelocity = 0;
			if(this.framesSinceLastBeat > 600) { this.danceTempo = 0; this.tempoConfidence = 0; }
		}

		// 2. FLYWHEEL TEMPO UPDATE
		const detectedBPM = estimatedBPM;
		if(detectedBPM > 30 && detectedBPM < 300 && this.framesSinceLastBeat < this._silenceThreshold) {
			if(this.danceTempo === 0) {
				this.danceTempo = detectedBPM; this.tempoConfidence = 0.3;
			} else {
				const bpmDiff = Math.abs(detectedBPM - this.danceTempo) / this.danceTempo;
				const signedError = detectedBPM - this.danceTempo;
				const acquiring = this.tempoConfidence < 0.5;
				this._driftHistory.push(signedError > 0 ? 1 : -1);
				if(this._driftHistory.length > this._driftHistoryMax) this._driftHistory.shift();
				let driftSum = 0;
				for(const v of this._driftHistory) driftSum += v;
				const drifting = this._driftHistory.length >= 4 && Math.abs(driftSum) >= this._driftHistory.length - 1;
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

		const smoothedEnergy = this.danceEnergy;
		const energyScale = 1.0 + 0.05 * (smoothedEnergy - 0.5);
		const clampedEnergyScale = Math.max(0.95, Math.min(1.05, energyScale));
		this._baseVelocity = NATIVE_FPS * tempoRatio * clampedEnergyScale;

		const targetVelocity = this._baseVelocity;
		const recovering = this.phaseVelocity < targetVelocity * 0.5 && targetVelocity > 1;
		const velAlpha = recovering ? 0.2 : (this.tempoConfidence < 0.5 ? 0.08 : 0.015);
		this.phaseVelocity += (targetVelocity - this.phaseVelocity) * velAlpha;
		this.phaseVelocity = Math.max(0, Math.min(this.phaseVelocity, NATIVE_FPS * 3));

		// V3 FEATURE 4: musical structure state machine
		const energyDelta = this.danceEnergy - this._prevEnergy;
		this._prevEnergy = this.danceEnergy;
		const energyDropRatio = this._recentPeakEnergy > 0.01 ? this.danceEnergy / this._recentPeakEnergy : 1.0;

		switch(this.musicalState) {
			case 'steady':
				if(energyDelta > 0.001) {
					this._energyRiseCount += 1;
					if(this._energyRiseCount > 120) this.musicalState = 'building';
				} else {
					this._energyRiseCount = 0;
				}
				if(energyDropRatio < 0.2) this.musicalState = 'breakdown';
				break;
			case 'building':
				this.phaseVelocity *= 1.2;
				if(energyDelta < -0.01) {
					this.musicalState = 'drop';
					this._energyRiseCount = 0;
					this._dropFrameCount = 0;
				}
				break;
			case 'drop':
				this._dropFrameCount += 1;
				if(this._dropFrameCount > 30) {
					this.musicalState = 'steady';
					this._energyRiseCount = 0;
				}
				break;
			case 'breakdown':
				if(energyDropRatio > 0.5) {
					this.musicalState = 'steady';
					this._energyRiseCount = 0;
				}
				break;
		}

		// V3 FEATURE 1: pick a style profile (half-time -> headbang, quiet -> sway, else smooth)
		if(this.styleParams.perceivedBPMMultiplier < 1.0) {
			this.activeProfile = 'headbang';
		} else if(this.danceEnergy < 0.2 && this.phaseVelocity < 10) {
			this.activeProfile = 'sway';
		} else {
			this.activeProfile = 'smooth';
		}

		// Segment position for profile modulation
		let prevKF = LAST_KF;
		let nextKF = FIRST_KF;
		for(const kf of SORTED_KFS) {
			if(kf <= this.phase) prevKF = kf;
			if(kf > this.phase && nextKF === FIRST_KF) nextKF = kf;
		}
		let segmentLength = nextKF - prevKF;
		if(segmentLength <= 0) segmentLength += FRAME_COUNT;
		let posInSegment = this.phase - prevKF;
		if(posInSegment < 0) posInSegment += FRAME_COUNT;
		const tSeg = posInSegment / segmentLength;

		let profileMod;
		switch(this.activeProfile) {
			case 'smooth':
				profileMod = 1.0 + 0.05 * Math.sin(Math.PI * tSeg);
				break;
			case 'headbang':
				// Asymmetric: fast snap in first 30%, lazy 70%
				profileMod = tSeg < 0.3 ? 1.5 : 0.78;
				break;
			case 'sway':
				profileMod = 1.0 + 0.15 * Math.sin(Math.PI * tSeg);
				break;
			default:
				profileMod = 1.0;
		}

		const modulatedVelocity = this.phaseVelocity * profileMod;

		// Advance phase
		const correction = this.pendingCorrection * this._correctionDecay;
		this.pendingCorrection -= correction;
		if(Math.abs(this.pendingCorrection) < 0.1) this.pendingCorrection = 0;
		this.phase = pmod(this.phase + modulatedVelocity * dt + correction, FRAME_COUNT);

		// V3 FEATURE 3: overshoot spring decay (impulse added below on strong downbeats)
		if(Math.abs(this._springVelocity) > 0.01) {
			this._springVelocity *= this._springDamping;
			this.phase = pmod(this.phase + this._springVelocity * dt, FRAME_COUNT);
		}

		// V2 anticipation
		if(this._beatPredictionActive && this.danceTempo > 0) {
			const timeUntilPredicted = this._nextExpectedBeatTime - now;
			if(timeUntilPredicted <= 0.100 && timeUntilPredicted > -0.010 && !this._predictiveCorrectionApplied) {
				const latencyFrames = this.phaseVelocity * this.latencyCompensation;
				let lookupPhase = this.phase - latencyFrames;
				if(lookupPhase < 0) lookupPhase += FRAME_COUNT;
				const target = this.nearestRightKeyframe(lookupPhase);
				if(target !== null) {
					let error = target - lookupPhase;
					if(error > FRAME_COUNT / 2) error -= FRAME_COUNT;
					if(error < -FRAME_COUNT / 2) error += FRAME_COUNT;
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
			if(lookupPhase < 0) lookupPhase += FRAME_COUNT;
			const target = this.nearestRightKeyframe(lookupPhase);
			if(target !== null) {
				let error = target - lookupPhase;
				if(error > FRAME_COUNT / 2) error -= FRAME_COUNT;
				if(error < -FRAME_COUNT / 2) error += FRAME_COUNT;

				let scalePulse;
				if(this._grooveEnabled) {
					this._lastBeatBassEnergy = bassEnergy;
					scalePulse = 0.06 + bassEnergy * 0.16;
					this._beatResponseHistory.push({ beatStrength: bassEnergy, correctionMag: Math.abs(error), scalePulse });
				} else {
					scalePulse = 0.12 + bassEnergy * 0.08;
				}

				// V2: downbeat differentiation
				let emphasisMultiplier;
				if(beatInBar === 0) emphasisMultiplier = 1.3;
				else if(beatInBar === 2) emphasisMultiplier = 1.1;
				else emphasisMultiplier = 0.9;

				// V3 FEATURE 4: extra snap during drop
				const dropBoost = this.musicalState === 'drop' ? 1.3 : 1.0;

				const maxDirectSnapError = AVG_KF_SPACING * emphasisMultiplier * dropBoost;

				if(Math.abs(error) < maxDirectSnapError) {
					this.phase = pmod(this.phase + error, FRAME_COUNT);
					this.pendingCorrection = 0;
				} else {
					const snapStrength = (this.tempoConfidence > 0.5 ? 0.6 : 0.8) * emphasisMultiplier * dropBoost;
					this.pendingCorrection += error * snapStrength * this.beatReactivity;
				}
				this.recentErrors.push({ time: now, error });
				this._bassHitEnergy = 0.5 + bassEnergy * 0.5;

				// V3 FEATURE 3: spring impulse on strong downbeats
				const isDownbeat = beatInBar === 0;
				if(isDownbeat && bassEnergy > 0.6) {
					this._springVelocity += 2.0 * bassEnergy;
				}
			}
			this.recentBeats.push(now);

			if(this._beatPredictionActive && this._nextExpectedBeatTime > 0) {
				const predictionError = Math.abs(now - this._nextExpectedBeatTime);
				if(predictionError < 0.050) this._predictionHits += 1;
				else this._predictionMisses += 1;
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

		// 5b. ENERGY-BASED BREAKDOWN DETECTION
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

		// 6. SCALE (held at 1.0 — bouncing intentionally disabled in Swift)
		this.currentScale = 1.0;

		// V3 FEATURE 2: vibe drift LFO applied to displayed phase
		this._vibeDriftPhase += dt / this._vibeDriftPeriod * 2 * Math.PI;
		if(this._vibeDriftPhase > 2 * Math.PI) this._vibeDriftPhase -= 2 * Math.PI;
		this._vibeDriftAmplitude = (1.0 - this.tempoConfidence) * 0.5;

		const driftOffset = this._vibeDriftAmplitude * Math.sin(this._vibeDriftPhase);
		const driftedPhase = this.phase + driftOffset;
		this.displayedFrame = pmod(Math.floor(driftedPhase), FRAME_COUNT);

		// Track keyframe crossings
		if(this._prevFrame >= 0 && this.displayedFrame !== this._prevFrame) {
			const traversed = [];
			if(this.displayedFrame > this._prevFrame) {
				for(let f = this._prevFrame + 1; f <= this.displayedFrame; f++) traversed.push(f);
			} else {
				for(let f = this._prevFrame + 1; f < FRAME_COUNT; f++) traversed.push(f);
				for(let f = 0; f <= this.displayedFrame; f++) traversed.push(f);
			}
			for(const f of traversed) {
				if(!ALL_KEYFRAMES.has(f)) continue;
				const side = LEFT_BEATS.has(f) ? 'L' : RIGHT_BEATS.has(f) ? 'R' : '?';
				this.keyframeCrossings.push({ time: now, frame: f, side });
			}
		}
		this._prevFrame = this.displayedFrame;

		this._velocityHistory.push(this.phaseVelocity);
		this._energyHistory.push(bassEnergy);

		const cutoff = now - 30;
		// Filter old timeline entries — small arrays, splice-from-front via while loop is cheaper than .filter
		while(this.recentBeats.length && this.recentBeats[0] < cutoff) this.recentBeats.shift();
		while(this.recentErrors.length && this.recentErrors[0].time < cutoff) this.recentErrors.shift();
		while(this.keyframeCrossings.length && this.keyframeCrossings[0].time < cutoff) this.keyframeCrossings.shift();
		if(this._velocityHistory.length > 1800) this._velocityHistory.splice(0, this._velocityHistory.length - 1800);
		if(this._energyHistory.length > 1800) this._energyHistory.splice(0, this._energyHistory.length - 1800);
		if(this._beatResponseHistory.length > 200) this._beatResponseHistory.splice(0, this._beatResponseHistory.length - 200);
	}
}

export { FRAME_COUNT, NATIVE_FPS, NATIVE_BPM, BEAT_KEYFRAMES, LEFT_BEATS, RIGHT_BEATS };
