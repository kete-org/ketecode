// Kete Code for JetBrains IDEs: a thin client of the plugin's own `kete serve` (CLAUDE.md §3, §6),
// bundled in the per-OS release zips or downloaded and verified on first use (the Marketplace build).
// Builds run in CI (.github/workflows/kete-jetbrains.yml); see README.md.
//
//   ./gradlew buildPlugin test                     plugin zip without binaries (build/distributions) and unit tests
//   ./gradlew verifyPlugin -PverifyIde=IU:2026.2.3 the Plugin Verifier against one IDE
//   ./gradlew buildPlugin -PpluginVersion=0.3.0 -PketeBinaries=<dir>
//                                                  a release build bundling <dir>/<os>-<arch>/kete[.exe]

import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion
import java.util.Base64

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
            Kete Code runtime (the <code>kete</code> CLI): chat in a tool window, your current file and selection as
            context, the agent's changes in the IDE's diff viewer, approvals and notifications, and your Kete account.</p>
            <p>Bring your own model keys, run local models, or sign in to the Kete Model Gateway.</p>
            <p><b>First use downloads the Kete Code CLI.</b> This plugin doesn't include the <code>kete</code> binary.
            The first time it's needed, the plugin asks, then downloads the <code>kete</code> of its own version for your
            operating system (about 80&ndash;95 MB) from
            <a href="https://github.com/kete-org/kete-releases">github.com/kete-org/kete-releases</a>, checks it against
            Kete Code's Ed25519 release signing key and the signed SHA-256 checksums, and refuses to run it if anything
            doesn't match. It is stored in the IDE's system folder. For offline installs, the GitHub Release also has
            per-OS plugin zips with the binary included; you can also point the plugin at your own <code>kete</code> in
            Settings &rarr; Tools &rarr; Kete Code.</p>
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

// The per-OS release zips bundle the per-platform `kete` binaries: <keteBinaries>/<os>-<arch>/kete[.exe]
// lands in the plugin's bin/ folder (see src/main/kotlin/ai/ketecode/jetbrains/core/Binary.kt). Without
// -PketeBinaries (the Marketplace zip) the plugin downloads its version's binary on first use.
val keteBinaries = providers.gradleProperty("keteBinaries")

// The Ed25519 keys a downloaded release must be signed with are `kete upgrade`'s, copied from the CLI's
// source at build time so a key rotation is one edit (packages/cli/src/kete/update-keys.json, ADR 0009).
val updateKeys = layout.projectDirectory.file("../cli/src/kete/update-keys.json")

abstract class GenerateUpdateKeys : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val source: RegularFileProperty

    @get:OutputDirectory
    abstract val output: DirectoryProperty

    @TaskAction
    fun generate() {
        val file = source.get().asFile
        if (!file.isFile) throw GradleException("${file.path} is missing: the plugin can't verify downloads without the pinned update keys")
        val keys = ((groovy.json.JsonSlurper().parse(file) as? Map<*, *>)?.get("keys") as? List<*>).orEmpty()
        if (keys.isEmpty()) throw GradleException("${file.path} has no keys: the plugin can't verify downloads without a pinned update key")
        keys.forEachIndexed { index, entry ->
            val key = entry as? Map<*, *>
            val id = key?.get("id") as? String
            val publicKey = key?.get("publicKey") as? String
            val size = publicKey?.let { runCatching { Base64.getDecoder().decode(it).size }.getOrNull() }
            if (id.isNullOrEmpty() || size != 32) throw GradleException("${file.path} key $index is not { id, publicKey: <32-byte base64> }")
        }
        val target = output.get().file("ai/ketecode/jetbrains/update-keys.json").asFile
        target.parentFile.mkdirs()
        file.copyTo(target, overwrite = true)
    }
}

val generateUpdateKeys = tasks.register<GenerateUpdateKeys>("generateUpdateKeys") {
    source = updateKeys
    output = layout.buildDirectory.dir("generated/update-keys")
}

sourceSets {
    main {
        resources.srcDir(generateUpdateKeys)
    }
}

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
        // eachFile, not filesMatching: a filesMatching rule here leaves the entry at rw-r--r--.
        eachFile {
            if (relativePath.segments.let { it.size == 4 && it[1] == "bin" && it[3] == "kete" }) {
                permissions { unix("rwxr-xr-x") }
            }
        }
    }

    test {
        useJUnitPlatform()
        // BridgeTest checks the bridge allowlists against the VS Code relay's, read from its source.
        val vscodeChat = layout.projectDirectory.file("../kete-vscode/src/chat.ts")
        inputs.file(vscodeChat).withPathSensitivity(PathSensitivity.NONE)
        systemProperty("kete.vscodeChat", vscodeChat.asFile.absolutePath)
        // UpdateKeysResourceTest compares the generated resource with the CLI's file.
        inputs.file(updateKeys).withPathSensitivity(PathSensitivity.NONE)
        systemProperty("kete.updateKeys", updateKeys.asFile.absolutePath)
        // The opt-in live test (CliLiveReleaseTest) downloads a real release: KETE_LIVE_RELEASE=<version>.
        providers.environmentVariable("KETE_LIVE_RELEASE").orNull?.let { systemProperty("kete.liveRelease", it) }
        providers.environmentVariable("KETE_LIVE_TARGET").orNull?.let { systemProperty("kete.liveTarget", it) }
        testLogging {
            events("failed")
            exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        }
    }
}
