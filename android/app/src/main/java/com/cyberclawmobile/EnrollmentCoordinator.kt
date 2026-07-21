package com.cyberclawmobile

import java.util.concurrent.atomic.AtomicBoolean

/**
 * v3.10.66: mic-contention coordinator for active enrollment.
 *
 * The Android microphone is a single-resource device — only one
 * `AudioRecord(MIC, …)` can have `RECORDSTATE_RECORDING` at a
 * time across an app. When `WakeWordModule.startActiveEnrollment()`
 * opens its own `AudioRecord` for the 30s voice capture, both
 * `CyberClawService` (BG listening) AND `WakeWordModule`'s
 * foreground wake-listener may already be holding the mic. The
 * active-enrollment `AudioRecord.read()` then returns 0
 * (silent capture) and the enrollment never accumulates
 * samples — the UI shows "Voice-active samples: 0" indefinitely.
 *
 * Old (v3.10.62–v3.10.65): no coordination. Active enrollment
 * just hopes the mic is free.
 *
 * New (v3.10.66): this singleton holds a single
 * `AtomicBoolean` that both `startActiveEnrollment` /
 * `stopActiveEnrollment` set, AND the BG / foreground listeners
 * check before opening their own mic or while running their
 * listen loop. If `isActive = true`, the BG service and the
 * foreground wake listener either:
 *   - Refuse to start (foreground listener)
 *   - Quietly tear down their recorder (BG service, since
 *     Android may have granted it the mic BEFORE enrollment
 *     started; we release it as soon as enrollment is requested).
 *
 * After `stopActiveEnrollment`, the BG service is restarted.
 * The foreground listener is NOT auto-restarted — the user
 * decides when they want wake-listening back (this keeps
 * behavior predictable; they can hit "Stop early" multiple
 * times without thrashing the mic).
 *
 * Threading: AtomicBoolean is the only state. Cheap to read in
 * the listen loop's hot path.
 */
object EnrollmentCoordinator {
    @Volatile
    var isActive: Boolean = false
        private set

    /**
     * Mark active enrollment as running. Called by
     * `WakeWordModule.startActiveEnrollment()`.
     */
    fun begin() {
        isActive = true
        android.util.Log.i(
            "EnrollmentCoordinator",
            "Active enrollment started — BG/foreground mic gated"
        )
    }

    /**
     * Mark active enrollment as no longer running. Called by
     * `WakeWordModule.stopActiveEnrollment()`.
     */
    fun end() {
        isActive = false
        android.util.Log.i(
            "EnrollmentCoordinator",
            "Active enrollment ended — BG/foreground mic allowed"
        )
    }
}
