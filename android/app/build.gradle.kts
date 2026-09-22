plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

val lanHost = providers.exec {
    commandLine("ipconfig", "getifaddr", "en0")
    isIgnoreExitValue = true
}.standardOutput.asText.map { output ->
    val ip = output.trim()
    if (ip.matches(Regex("""\d+\.\d+\.\d+\.\d+"""))) ip else "127.0.0.1"
}.get()

fun viteProxyFromEnv(key: String, fallback: String): String {
    val envFile = rootProject.file("../frontend-new/.env")
    if (!envFile.isFile) return fallback
    val line =
        envFile.readLines()
            .map { it.trim() }
            .firstOrNull { it.startsWith("$key=") && !it.startsWith("#") }
            ?: return fallback
    val value = line.substringAfter("=").trim().trim('"').trim('\'')
    return value.ifBlank { fallback }
}

val remoteApiBase = viteProxyFromEnv("VITE_API_PROXY", "https://sugarbackend.mxjprod.work")
val remoteMediaBase = viteProxyFromEnv("VITE_MEDIA_PROXY", "https://sugarbackend.mxjprod.work")

android {
    namespace = "com.sugarscratchie.smoke"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.sugarscratchie.smoke"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        // Phone builds talk to this Mac over Wi-Fi. Emulator still uses 10.0.2.2.
        buildConfigField("String", "LAN_HOST", "\"$lanHost\"")
        // Matches frontend-new/.env VITE_API_PROXY / VITE_MEDIA_PROXY when present.
        buildConfigField("String", "REMOTE_API_BASE_URL", "\"$remoteApiBase\"")
        buildConfigField("String", "REMOTE_MEDIA_BASE_URL", "\"$remoteMediaBase\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    val media3 = "1.4.1"
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-ui:$media3")
    implementation("androidx.media3:media3-datasource-okhttp:$media3")

    implementation("com.airbnb.android:lottie:6.6.2")
    implementation("com.airbnb.android:lottie-compose:6.6.2")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
