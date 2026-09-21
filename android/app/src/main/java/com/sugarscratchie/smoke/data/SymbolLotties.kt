package com.sugarscratchie.smoke.data

import com.airbnb.lottie.LottieComposition
import com.airbnb.lottie.LottieCompositionFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import java.util.zip.ZipInputStream

/** Same catalog order as the web match game (`DEFAULT_SYMBOL_TYPES`). */
object SymbolLotties {
    val files =
        listOf(
            "01-Heart.lottie",
            "02-Lock.lottie",
            "03-GemDiamond.lottie",
            "04-Star.lottie",
            "05-Diamond.lottie",
            "06-Magnet.lottie",
            "07-Crown.lottie",
            "08-Gold Coins.lottie",
            "09-Key.lottie",
            "10-Treasure Chest.lottie",
            "11-Diamond Cards.lottie",
            "12-WinnerTrophy.lottie",
        )

    val labels =
        listOf(
            "Heart",
            "Lock",
            "Gem",
            "Star",
            "Diamond",
            "Magnet",
            "Crown",
            "Gold Coins",
            "Key",
            "Treasure Chest",
            "Diamond Cards",
            "Trophy",
        )

    suspend fun load(api: SugarApi): List<LottieComposition> =
        withContext(Dispatchers.IO) {
            files
                .map { file ->
                    async {
                        try {
                            val bytes = api.fetchBytes(api.mediaUrl("/lotties/$file"))
                            val json = animationJson(bytes)
                            LottieCompositionFactory.fromJsonStringSync(json, file).value
                        } catch (_: Exception) {
                            null
                        }
                    }
                }.awaitAll()
                .filterNotNull()
        }

    private fun animationJson(bytes: ByteArray): String {
        ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
            var entry = zip.nextEntry
            while (entry != null) {
                if (!entry.isDirectory && entry.name.endsWith(".json") && !entry.name.endsWith("manifest.json")) {
                    return zip.readBytes().decodeToString()
                }
                entry = zip.nextEntry
            }
        }
        error("dotLottie archive has no animation")
    }
}
