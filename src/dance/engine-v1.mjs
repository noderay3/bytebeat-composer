// DanceEngineV1 — phase-locked dance engine ported from Swift DanceEngine.swift
// Drives a 264-frame cat sprite via beat-detector input.

const FRAME_COUNT = 264;
const NATIVE_FPS = 30;
const NATIVE_BPM = 123;
const BEAT_KEYFRAMES = [0, 8, 16, 24, 30, 38, 46, 54, 60, 68, 74, 82, 90, 96, 104, 112, 118, 124, 132, 138, 146, 152, 160, 168, 176, 182, 190, 196, 204, 212, 220, 226, 236, 244, 250, 256];
const LEFT_BEATS = new Set([8, 24, 38, 54, 68, 82, 96, 112, 124, 138, 152, 168, 182, 196, 212, 226, 244, 256]);
const RIGHT_BEATS = new Set([0, 16, 30, 46, 60, 74, 90, 104, 118, 132, 146, 160, 176, 190, 204, 220, 236, 250]);
const ALL_KEYFRAMES = new Set(BEAT_KEYFRAMES);

// Cosine-interpolated bob position: -1 = right keyframe, +1 = left
function bobPosition(phase) {
	const fc = FRAME_COUNT;
	let p = phase % fc;
	if (p < 0) p += fc;

	let lo = 0, hi = BEAT_KEYFRAMES.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (BEAT_KEYFRAMES[mid] <= p) lo = mid; else hi = mid - 1;
	}
	const prevIdx = lo;
	const nextIdx = (prevIdx + 1) % BEAT_KEYFRAMES.length;

	const prevFrame = BEAT_KEYFRAMES[prevIdx];
	let nextFrame = BEAT_KEYFRAMES[nextIdx];
	if (nextIdx === 0) nextFrame = fc + BEAT_KEYFRAMES[0];

	const span = nextFrame - prevFrame;
	const t = span > 0 ? (p - prevFrame) / span : 0;

	const prevIsRight = RIGHT_BEATS.has(BEAT_KEYFRAMES[prevIdx]);
	const prevVal = prevIsRight ? -1 : 1;
	const nextVal = -prevVal;

	const cosT = (1 - Math.cos(Math.PI * t)) / 2;
	return prevVal + (nextVal - prevVal) * cosT;
}

// Default style params; matches Swift StyleParams() defaults
function defaultStyleParams() {
	return {
		perceivedBPMMultiplier: 1.0,
		beatSourceMidWeight: 0.0,
		pulseMaintenanceSeconds: 8.0,
		idleConfidenceThreshold: 0.3,
		minBobBPM: 50,
		maxBobBPM: 160,
	};
}

// Auto-detect style from audio features — mirrors StyleInference.infer
function inferStyle(bpm, kickDensity, snareProminence, bassEnergy, confidence) {
	const fourOnTheFloor = {
		perceivedBPMMultiplier: 1.0,
		beatSourceMidWeight: 0.0,
		pulseMaintenanceSeconds: 10.0,
		idleConfidenceThreshold: 0.2,
		minBobBPM: 40,
		maxBobBPM: 200,
	};
	const halfTimeBass = {
		perceivedBPMMultiplier: 0.5,
		beatSourceMidWeight: 0.0,
		pulseMaintenanceSeconds: 12.0,
		idleConfidenceThreshold: 0.3,
		minBobBPM: 40,
		maxBobBPM: 200,
	};
	const halfTimeSnare = {
		perceivedBPMMultiplier: 0.5,
		beatSourceMidWeight: 0.6,
		pulseMaintenanceSeconds: 5.0,
		idleConfidenceThreshold: 0.3,
		minBobBPM: 40,
		maxBobBPM: 200,
	};
	const ambient = {
		perceivedBPMMultiplier: 1.0,
		beatSourceMidWeight: 0.0,
		pulseMaintenanceSeconds: 0.0,
		idleConfidenceThreshold: 0.7,
		minBobBPM: 40,
		maxBobBPM: 200,
	};

	let params = { ...fourOnTheFloor };
	if (bpm > 155) {
		if (kickDensity < 0.7 || snareProminence > 0.4) {
			params.perceivedBPMMultiplier = 0.5;
			params.pulseMaintenanceSeconds = 12.0;
		}
	} else if (bpm > 125) {
		if (kickDensity < 0.6 && snareProminence > 0.5) {
			params = halfTimeSnare;
		} else if (kickDensity < 0.7) {
			params = halfTimeBass;
		}
	} else if (bpm < 70 && confidence < 0.3) {
		params = ambient;
	}
	return params;
}

export class DanceEngineV1 {
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

		this.breakdownTimer = 0;
		this.recentPeakEnergy = 0;

		this.currentScale = 1.0;
		this.danceEnergy = 0;
		this.bassHitEnergy = 0;

		this.grooveEnabled = true;
		this.baseVelocity = 15;
		this.energySmoothed = 0;
		this.amplitudeEnvelope = 0.5;
		this.shimmerPhase = 0;
		this.lastBeatBassEnergy = 0;

		this.prevFrame = -1;

		// Predictive beat scheduling
		this.nextExpectedBeatTime = 0;
		this.lastBeatTime = 0;
		this.beatPredictionActive = false;
		this.predictionHits = 0;
		this.predictionMisses = 0;
		this.predictiveCorrectionApplied = false;
	}

	reset() {
		this.phase = 0;
		this.phaseVelocity = 15;
		this.danceTempo = 0;
		this.tempoConfidence = 0;
		this.pendingCorrection = 0;
		this.displayedFrame = 0;
		this.framesSinceLastBeat = 999;
		this.driftHistory = [];
		this.currentScale = 1.0;
		this.danceEnergy = 0;
		this.bassHitEnergy = 0;
		this.baseVelocity = 15;
		this.energySmoothed = 0;
		this.amplitudeEnvelope = 0.5;
		this.shimmerPhase = 0;
		this.lastBeatBassEnergy = 0;
		this.nextExpectedBeatTime = 0;
		this.lastBeatTime = 0;
		this.beatPredictionActive = false;
		this.predictionHits = 0;
		this.predictionMisses = 0;
		this.predictiveCorrectionApplied = false;
		this.breakdownTimer = 0;
		this.recentPeakEnergy = 0;
		this.prevFrame = -1;
	}

	get isPredicting() {
		return this.beatPredictionActive;
	}

	get predictionAccuracy() {
		const total = this.predictionHits + this.predictionMisses;
		return total > 0 ? this.predictionHits / total : 0;
	}

	bobPosition(phase) {
		return bobPosition(phase ?? this.phase);
	}

	// Find nearest RIGHT keyframe; beats should land on right bobs
	nearestRightKeyframe(frame) {
		const fc = FRAME_COUNT;
		let bestDist = fc;
		let bestFrame = 0;
		for (const kf of RIGHT_BEATS) {
			const fwd = kf >= frame ? kf - frame : kf + fc - frame;
			const bwd = frame >= kf ? frame - kf : frame + fc - kf;
			const dist = Math.min(fwd, bwd);
			if (dist < bestDist) { bestDist = dist; bestFrame = kf; }
		}
		return bestDist < fc ? bestFrame : null;
	}

	nearestKeyframe(frame) {
		const fc = FRAME_COUNT;
		let bestDist = fc;
		let bestFrame = 0;
		for (const kf of BEAT_KEYFRAMES) {
			const fwd = kf >= frame ? kf - frame : kf + fc - frame;
			const bwd = frame >= kf ? frame - kf : frame + fc - kf;
			const dist = Math.min(fwd, bwd);
			if (dist < bestDist) { bestDist = dist; bestFrame = kf; }
		}
		return bestFrame;
	}

	tick(dt, detector, now) {
		const fc = FRAME_COUNT;

		// 1. Silence detection
		if (detector.isBeat) this.framesSinceLastBeat = 0;
		else this.framesSinceLastBeat++;
		if (this.framesSinceLastBeat > this.silenceThreshold) {
			this.phaseVelocity *= 0.95;
			if (this.phaseVelocity < 0.5) this.phaseVelocity = 0;
			if (this.framesSinceLastBeat > 600) { this.danceTempo = 0; this.tempoConfidence = 0; }
		}

		// 2. Flywheel tempo update
		const detectedBPM = detector.estimatedBPM;
		if (detectedBPM > 30 && detectedBPM < 300 && this.framesSinceLastBeat < this.silenceThreshold) {
			if (this.danceTempo === 0) {
				this.danceTempo = detectedBPM;
				this.tempoConfidence = 0.3;
			} else {
				const bpmDiff = Math.abs(detectedBPM - this.danceTempo) / this.danceTempo;
				const signedError = detectedBPM - this.danceTempo;
				const acquiring = this.tempoConfidence < 0.5;
				this.driftHistory.push(signedError > 0 ? 1 : -1);
				if (this.driftHistory.length > this.driftHistoryMax) this.driftHistory.shift();
				const driftSum = this.driftHistory.reduce((a, b) => a + b, 0);
				const drifting = this.driftHistory.length >= 4 && Math.abs(driftSum) >= this.driftHistory.length - 1;
				const driftMul = drifting ? 50.0 : 1.0;
				if (bpmDiff < 0.03) {
					this.tempoConfidence = Math.min(1.0, this.tempoConfidence + 0.01);
					this.danceTempo += signedError * (acquiring ? 0.05 : 0.005) * driftMul;
				} else if (bpmDiff < 0.10) {
					this.tempoConfidence = Math.min(1.0, this.tempoConfidence + 0.003);
					this.danceTempo += signedError * (acquiring ? 0.08 : 0.008) * driftMul;
				} else if (bpmDiff < 0.25) {
					this.danceTempo += signedError * (acquiring ? 0.05 : 0.005) * driftMul;
					this.tempoConfidence = Math.max(0, this.tempoConfidence - 0.005);
				} else {
					this.tempoConfidence = Math.max(0, this.tempoConfidence - 0.02);
					if (this.tempoConfidence < 0.05) this.danceTempo += signedError * 0.08;
				}
			}
		}

		// 3. Phase velocity
		const perceivedBPM = this.danceTempo * this.styleParams.perceivedBPMMultiplier;
		let clampedBPM = perceivedBPM;
		if (this.styleParams.perceivedBPMMultiplier >= 1.0) {
			if (clampedBPM > 200) clampedBPM /= 2;
			if (clampedBPM < 40 && clampedBPM > 0) clampedBPM *= 2;
		}

		const tempoRatio = clampedBPM > 0 ? clampedBPM / NATIVE_BPM : 0;
		this.baseVelocity = NATIVE_FPS * tempoRatio * (0.5 + this.vibeIntensityMultiplier * 0.5);
		const targetVelocity = this.baseVelocity;

		const recovering = this.phaseVelocity < targetVelocity * 0.5 && targetVelocity > 1;
		const velAlpha = recovering ? 0.2 : (this.tempoConfidence < 0.5 ? 0.08 : 0.015);
		this.phaseVelocity += (targetVelocity - this.phaseVelocity) * velAlpha;
		this.phaseVelocity = Math.max(0, Math.min(this.phaseVelocity, NATIVE_FPS * 3));

		// Advance phase
		const correction = this.pendingCorrection * this.correctionDecay;
		this.pendingCorrection -= correction;
		if (Math.abs(this.pendingCorrection) < 0.1) this.pendingCorrection = 0;
		this.phase += this.phaseVelocity * dt + correction;
		this.phase = this.phase % fc;
		if (this.phase < 0) this.phase += fc;

		// 3b. Predictive beat pre-correction — gentle nudge just before expected beat
		if (this.beatPredictionActive && this.danceTempo > 0 && !this.predictiveCorrectionApplied) {
			const timeUntilPredicted = this.nextExpectedBeatTime - now;
			if (timeUntilPredicted <= 0.010 && timeUntilPredicted > -0.030) {
				const latencyFrames = this.phaseVelocity * this.latencyCompensation;
				let lookupPhase = this.phase - latencyFrames;
				if (lookupPhase < 0) lookupPhase += fc;
				const target = this.nearestRightKeyframe(lookupPhase);
				if (target !== null) {
					let error = target - lookupPhase;
					if (error > fc / 2) error -= fc;
					if (error < -fc / 2) error += fc;
					const preSnapStrength = 0.25 * (this.tempoConfidence > 0.5 ? 0.4 : 0.6);
					this.pendingCorrection += error * preSnapStrength * this.beatReactivity;
				}
				this.predictiveCorrectionApplied = true;
			}
		}

		// 4. Beat-triggered phase correction
		if (detector.isBeat) {
			const latencyFrames = this.phaseVelocity * this.latencyCompensation;
			let lookupPhase = this.phase - latencyFrames;
			if (lookupPhase < 0) lookupPhase += fc;
			const target = this.nearestRightKeyframe(lookupPhase);
			if (target !== null) {
				let error = target - lookupPhase;
				if (error > fc / 2) error -= fc;
				if (error < -fc / 2) error += fc;

				const bassEnergy = detector.bassEnergy ?? 0;
				if (this.grooveEnabled) {
					this.lastBeatBassEnergy = bassEnergy;
				}

				// Small error: snap directly. Large: gradual correction to avoid visible jump.
				const avgSpacing = fc / BEAT_KEYFRAMES.length;
				if (Math.abs(error) < avgSpacing) {
					this.phase += error;
					this.phase = this.phase % fc;
					if (this.phase < 0) this.phase += fc;
					this.pendingCorrection = 0;
				} else {
					const snapStrength = this.tempoConfidence > 0.5 ? 0.6 : 0.8;
					this.pendingCorrection += error * snapStrength * this.beatReactivity;
				}
				this.bassHitEnergy = 0.5 + bassEnergy * 0.5;
			}

			// Prediction tracking
			if (this.beatPredictionActive && this.nextExpectedBeatTime > 0) {
				const predictionError = Math.abs(now - this.nextExpectedBeatTime);
				if (predictionError < 0.050) this.predictionHits++;
				else this.predictionMisses++;
				if (this.predictionMisses > this.predictionHits) this.beatPredictionActive = false;
			}

			this.lastBeatTime = now;
			const beatPeriod = this.danceTempo > 0 ? 60.0 / this.danceTempo : 0;
			this.nextExpectedBeatTime = now + beatPeriod;
			this.predictiveCorrectionApplied = false;

			if (!this.beatPredictionActive && this.tempoConfidence > 0.4) {
				this.beatPredictionActive = true;
				this.predictionHits = 0;
				this.predictionMisses = 0;
			}
		}

		// 5. Energy
		const bassE = detector.bassEnergy ?? 0;
		const midE = detector.midEnergy ?? 0;
		const trebE = detector.trebEnergy ?? 0;
		const targetEnergy = bassE * 0.5 + midE * 0.3 + trebE * 0.2;
		this.danceEnergy += (targetEnergy - this.danceEnergy) * 0.08;
		this.bassHitEnergy *= 0.92;

		if (this.grooveEnabled) {
			this.energySmoothed += (targetEnergy - this.energySmoothed) * 0.02;
			this.amplitudeEnvelope = Math.min(1.0, this.energySmoothed * 2.0);
			const shimmerFreq = 12.0;
			this.shimmerPhase += shimmerFreq * dt * 2 * Math.PI;
			if (this.shimmerPhase > 2 * Math.PI) this.shimmerPhase -= 2 * Math.PI;
		}

		// 5b. Breakdown detection — decelerate if energy collapses past style's maintenance window
		const currentEnergy = bassE + midE * 0.5;
		if (currentEnergy < this.recentPeakEnergy * 0.2 && this.recentPeakEnergy > 0.1) {
			this.breakdownTimer += dt;
			const maintenanceLimit = this.styleParams.pulseMaintenanceSeconds;
			if (this.breakdownTimer > maintenanceLimit && maintenanceLimit > 0) {
				this.phaseVelocity *= 0.95;
			}
		} else {
			this.breakdownTimer = 0;
			this.recentPeakEnergy = Math.max(this.recentPeakEnergy * 0.999, currentEnergy);
		}

		// 6. Scale stays at 1.0 in V1 (no bouncing)
		this.currentScale = 1.0;

		// Frame output
		this.displayedFrame = Math.floor(this.phase) % FRAME_COUNT;
		if (this.displayedFrame < 0) this.displayedFrame += FRAME_COUNT;
		this.prevFrame = this.displayedFrame;
	}
}

export { FRAME_COUNT, NATIVE_FPS, NATIVE_BPM, BEAT_KEYFRAMES, LEFT_BEATS, RIGHT_BEATS, ALL_KEYFRAMES, bobPosition, inferStyle };
