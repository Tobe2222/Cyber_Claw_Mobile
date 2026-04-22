package com.cyberclawmobile

/**
 * PhoneticMatcher — fuzzy/phonetic wake phrase matching
 *
 * Uses a combination of:
 * 1. Exact substring match (fast path)
 * 2. Levenshtein edit distance per word (handles typos/mishearing)
 * 3. Soundex-like consonant skeleton matching (handles vowel differences like "clawsuu" → "closer")
 */
object PhoneticMatcher {

    /**
     * Returns true if [heard] is a plausible match for [target] phrase.
     * [threshold] 0.0–1.0, higher = stricter. Default 0.55 works well for wake words.
     */
    fun matches(heard: String, target: String, threshold: Double = 0.55): Boolean {
        val h = heard.lowercase().trim()
        val t = target.lowercase().trim()

        if (h.isEmpty() || t.isEmpty()) return false

        // Fast path: exact contains
        if (h.contains(t)) return true

        val heardWords = h.split(Regex("\\s+"))
        val targetWords = t.split(Regex("\\s+"))

        // Score each target word against best heard word match
        var totalScore = 0.0
        for (tw in targetWords) {
            val best = heardWords.maxOfOrNull { hw ->
                maxOf(
                    similarityScore(hw, tw),
                    consonantScore(hw, tw)
                )
            } ?: 0.0
            totalScore += best
        }

        val avgScore = totalScore / targetWords.size
        return avgScore >= threshold
    }

    /** Normalized similarity: 1.0 = identical, 0.0 = completely different */
    private fun similarityScore(a: String, b: String): Double {
        if (a == b) return 1.0
        if (a.isEmpty() || b.isEmpty()) return 0.0
        val maxLen = maxOf(a.length, b.length)
        val dist = levenshtein(a, b)
        return 1.0 - dist.toDouble() / maxLen
    }

    /**
     * Consonant skeleton score — strips vowels and doubles, compares remaining consonants.
     * "clawsuu" → "clws", "closer" → "clsr" → high similarity
     */
    private fun consonantScore(a: String, b: String): Double {
        val ca = consonantSkeleton(a)
        val cb = consonantSkeleton(b)
        if (ca.isEmpty() || cb.isEmpty()) return 0.0
        return similarityScore(ca, cb) * 0.9 // slight penalty vs exact match
    }

    private fun consonantSkeleton(s: String): String {
        val vowels = setOf('a', 'e', 'i', 'o', 'u')
        return s.lowercase()
            .filter { it.isLetter() && it !in vowels }
            .fold("") { acc, c -> if (acc.lastOrNull() == c) acc else acc + c } // dedupe doubles
    }

    private fun levenshtein(a: String, b: String): Int {
        val m = a.length; val n = b.length
        val dp = Array(m + 1) { IntArray(n + 1) }
        for (i in 0..m) dp[i][0] = i
        for (j in 0..n) dp[0][j] = j
        for (i in 1..m) for (j in 1..n) {
            dp[i][j] = if (a[i - 1] == b[j - 1]) dp[i - 1][j - 1]
            else 1 + minOf(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
        }
        return dp[m][n]
    }
}
