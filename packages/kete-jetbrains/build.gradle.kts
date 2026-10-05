// Kete Code for JetBrains IDEs: a thin client of the plugin's own bundled `kete serve` (CLAUDE.md §3,
// §6). Builds run in CI (.github/workflows/kete-jetbrains.yml); see README.md.
//
//   ./gradlew buildPlugin test                     plugin zip (build/distributions) and unit tests
//   ./gradlew verifyPlugin -PverifyIde=IU:2026.2.3 the Plugin Verifier against one IDE
//   ./gradlew buildPlugin -PpluginVersion=0.3.0 -PketeBinaries=<dir>
//                                                  a release build bundling <dir>/<os>-<arch>/kete[.exe]

import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.2.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "ai.ketecode"
version = providers.gradleProperty("pluginVersion").get()

kotlin {
    jvmToolchain(21)
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_21)
        // The oldest supported IDE (2024.3) ships the Kotlin 2.0 standard library; the plugin uses the
        // IDE's (kotlin.stdlib.default.dependency=false), so it must not need anything newer.
        apiVersion.set(KotlinVersion.KOTLIN_2_0)
        languageVersion.set(KotlinVersion.KOTLIN_2_0)
    }
}

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity(providers.gradleProperty("platformVersion"))
        // "Open in terminal": optional at runtime (META-INF/kete-terminal.xml).
        bundledPlugin("org.jetbrains.plugins.terminal")
        testFramework(TestFrameworkType.Platform)
    }
    testImplementation("org.junit.jupiter:junit-jupiter:5.13.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.13.4")
    // The platform's test framework refers to JUnit 4 classes; the tests themselves are JUnit 5.
    testRuntimeOnly("junit:junit:4.13.2")
}

intellijPlatform {
    // No Swing forms to instrument, and no searchable-options index (it starts a whole IDE).
    instrumentCode = false
    buildSearchableOptions = false

    pluginConfiguration {
        id = "ai.ketecode.kete-code"
        name = "Kete Code"
        version = project.version.toString()
        description =
            """
            <p>Kete Code is an AI coding agent that runs next to your code. This plugin is a thin client of the
            Kete Code runtime bundled with it: chat in a tool window, your current file and selection as context,
            the agent's changes in the IDE's diff viewer, approvals and notifications, and your Kete account.</p>
            <p>Bring your own model keys, run local models, or sign in to the Kete Model Gateway.</p>
            """.trimIndent()
        vendor {
            name = "Kete Code"
        }
        ideaVersion {
            sinceBuild = "243"
            // No upper bound: newer IDEs are checked by the Plugin Verifier in CI.
            untilBuild = provider { null }
        }
    }

    pluginVerification {
        failureLevel = listOf(
            VerifyPluginTask.FailureLevel.COMPATIBILITY_PROBLEMS,
            VerifyPluginTask.FailureLevel.INVALID_PLUGIN,
        )
        ides {
            // One IDE per run (CI runs a matrix), e.g. -PverifyIde=IU:2026.2.3.
            val requested = providers.gradleProperty("verifyIde").orNull
            if (requested != null) {
                val (code, ideVersion) = requested.split(":", limit = 2)
                create(IntelliJPlatformType.fromCode(code), ideVersion)
            } else {
                create(IntelliJPlatformType.IntellijIdeaCommunity, providers.gradleProperty("platformVersion").get())
            }
        }
    }

    publishing {
        // Only kete-jetbrains-publish.yml publishes, with the token from its environment.
        token = providers.environmentVariable("JETBRAINS_MARKETPLACE_TOKEN")
    }
}

// Release builds bundle the per-platform `kete` binaries: <keteBinaries>/<os>-<arch>/kete[.exe] lands
// in the plugin's bin/ folder (see src/main/kotlin/ai/ketecode/jetbrains/core/Binary.kt).
val keteBinaries = providers.gradleProperty("keteBinaries")

tasks {
    prepareSandbox {
        if (keteBinaries.isPresent) {
            from(keteBinaries) {
                into(intellijPlatform.projectName.map { "$it/bin" })
                filePermissions { unix("rwxr-xr-x") }
            }
        }
    }

    // Gradle 9 archives are reproducible by default and reset every file to rw-r--r--, so the zip
    // would drop the sandbox's executable bit: set it again on the bundled binaries.
    buildPlugin {
        filesMatching("*/bin/*/kete") {
            permissions { unix("rwxr-xr-x") }
        }
    }

    test {
        useJUnitPlatform()
        // BridgeTest checks the bridge allowlists against the VS Code relay's, read from its source.
        val vscodeChat = layout.projectDirectory.file("../kete-vscode/src/chat.ts")
        inputs.file(vscodeChat).withPathSensitivity(PathSensitivity.NONE)
        systemProperty("kete.vscodeChat", vscodeChat.asFile.absolutePath)
        testLogging {
            events("failed")
            exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        }
    }
}
