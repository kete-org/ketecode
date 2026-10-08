/**
 * Generates bundles.json: change-bundle test vectors for the runner's Go port of the platform's
 * bundle validator (packages/kete-job-host/internal/bundle). Every expected result is what the
 * platform's own validator (kete-code-platform apps/portal/lib/jobs/bundle/validate.ts) answers
 * for the bundle, run on Node; the bundles are built with the platform's test builder
 * (apps/portal/test/bundle-builder.ts) or by hand below. Deterministic: no randomness, no clock.
 *
 * Regenerate with ./generate.sh <kete-code-platform checkout> (never edit bundles.json by hand).
 * `@portal/*` resolves to <platform>/apps/portal/* through the temporary tsconfig generate.sh writes.
 */
import { createHash } from 'node:crypto'
import { deflateRawSync, gzipSync } from 'node:zlib'
import { validateBundle } from '@portal/lib/jobs/bundle/validate'
import { bytes, concat, END, entry, entrypointBundle, goEntry, paxHeader, paxRecord, rawBundle, tarGz, tarHeader, type BundleInput } from '@portal/test/bundle-builder'

type Expect =
  | { ok: true; entries: Array<{ path: string; deleted?: true; mode?: string; blob_sha?: string; binary?: boolean; inline?: boolean }> }
  | { ok: false; reason: string }

const cases: Array<{ name: string; bundle_b64: string; expect: Expect }> = []
const enc = new TextEncoder()

async function add(name: string, bundle: Uint8Array): Promise<void> {
  if (cases.some((c) => c.name === name)) throw new Error(`duplicate case ${name}`)
  const r = await validateBundle(bundle)
  const expect: Expect = r.ok
    ? {
        ok: true,
        entries: r.entries.map((e) =>
          e.deleted ? { path: e.path, deleted: true as const } : { path: e.path, mode: e.mode, blob_sha: e.blobSha, binary: e.binary, inline: e.inline },
        ),
      }
    : { ok: false, reason: r.reason }
  cases.push({ name, bundle_b64: Buffer.from(bundle).toString('base64'), expect })
}

const file = (path: string, data: string | Uint8Array = `x ${path}\n`, mode: '100644' | '100755' = '100644'): BundleInput => ({ path, data, mode })
/** One file whose name may not suit the builder's PAX header naming (a long multibyte component). */
const ok1 = (path: string) => {
  const base = path.split('/').pop()!
  if (Buffer.byteLength(base) <= 80) return entrypointBundle([file(path)])
  return tarGz([goEntry('manifest.json', enc.encode(manifest([{ path, mode: '100644' }]))), paxHeader([paxRecord('path', `files/${path}`)], 'x'), entry('x', `x ${path}\n`)])
}
const manifest = (items: unknown[]) => JSON.stringify(items)
/** A bundle with one hand-written manifest and files/<p> entries for each listed path. */
const withFiles = (manifestText: string, files: string[]) => rawBundle(manifestText, files.map((p) => entry(`files/${p}`, `x ${p}\n`)))
const repeat = (ch: string, n: number) => ch.repeat(n)
const binaryOf = (n: number, seed = 1) => {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff
  b[0] = 0
  return b
}

/** The gzip bytes split into header, deflate data and trailer (gzipSync writes a 10-byte header). */
function gzParts(gz: Uint8Array) {
  return { header: gz.subarray(0, 10), body: gz.subarray(10, gz.length - 8), trailer: gz.subarray(gz.length - 8) }
}

/** A hand-made gzip member with header flags and fields. */
function gzipWith(data: Uint8Array, header: Uint8Array, crc?: number, size?: number): Uint8Array {
  const body = deflateRawSync(data)
  const t = new Uint8Array(8)
  const view = new DataView(t.buffer)
  view.setUint32(0, crc ?? crc32(data), true)
  view.setUint32(4, size ?? data.length, true)
  return concat([header, body, t])
}

function crc32(data: Uint8Array): number {
  let c = ~0
  for (const b of data) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}

const tarOf = (parts: Uint8Array[], end = true) => concat([...parts, ...(end ? [END] : [])])
const mEntry = (items: unknown[]) => entry('manifest.json', manifest(items))

async function main(): Promise<void> {
  // ---------------------------------------------------------------- accepted
  await add('accepted_basic', entrypointBundle([file('src/app.ts', 'export const x = 1\n'), file('bin/run.sh', '#!/bin/sh\necho hi\n', '100755'), { path: 'old.txt', deleted: true }, file('img/logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))]))
  await add('accepted_empty_manifest', entrypointBundle([]))
  await add('accepted_only_deletions', entrypointBundle([{ path: 'a.txt', deleted: true }, { path: 'dir/b.txt', deleted: true }]))
  await add('accepted_empty_file', entrypointBundle([file('empty.txt', '')]))
  await add('accepted_pax_unicode_path', entrypointBundle([file('docs/caf\u00e9.md', 'bonjour\n'), file('\u65e5\u672c/\u8a9e.txt', '\u3053\u3093\u306b\u3061\u306f\n')]))
  await add('accepted_ustar_prefix_split', entrypointBundle([file(`${repeat('d', 90)}/${repeat('e', 60)}/name.txt`)]))
  await add('accepted_pax_long_ascii_path', entrypointBundle([file(`${repeat('a', 120)}/${repeat('b', 120)}/${repeat('c', 120)}.txt`)]))
  await add('accepted_component_255_bytes', entrypointBundle([file(`dir/${repeat('n', 255)}`)]))
  {
    const parts = ['p'.repeat(250), 'q'.repeat(250), 'r'.repeat(250), 's'.repeat(250), 't'.repeat(250), 'u'.repeat(250), 'v'.repeat(250), 'w'.repeat(250), 'x'.repeat(250), 'y'.repeat(250), 'z'.repeat(250), 'a'.repeat(250), 'b'.repeat(250), 'c'.repeat(250), 'd'.repeat(250), 'e'.repeat(250)]
    const p = parts.join('/') // 16*250 + 15 = 4015 bytes
    await add('accepted_path_4096_bytes', entrypointBundle([file(p + '/' + 'f'.repeat(4096 - p.length - 1))]))
    await add('invalid_path_4097_bytes', entrypointBundle([file(p + '/' + 'f'.repeat(4097 - p.length - 1))]))
  }
  await add('accepted_gnu_long_name', tarGz([mEntry([{ path: 'long/name.txt', mode: '100644' }]), entry('././@LongLink', 'files/long/name.txt\u0000', { type: 'L', magic: 'gnu' }), entry('trunc', 'hello\n', { magic: 'gnu' })]))
  await add('accepted_gnu_magic_ignores_prefix', tarGz([mEntry([{ path: 'a.txt', mode: '100644' }]), entry('files/a.txt', 'a\n', { magic: 'gnu', prefix: 'junk' })]))
  await add('accepted_pax_named_manifest', tarGz([paxHeader([paxRecord('path', 'manifest.json')]), entry('m', manifest([{ path: 'a.txt', mode: '100644' }])), entry('files/a.txt', 'a\n')]))
  await add('accepted_typeflag_nul', tarGz([entry('manifest.json', manifest([{ path: 'a.txt', mode: '100644' }]), { type: '\u0000' }), entry('files/a.txt', 'a\n')]))
  await add('accepted_bom_tar_names', tarGz([entry('\ufeffmanifest.json', manifest([{ path: 'a.txt', mode: '100644' }])), entry('\ufefffiles/a.txt', 'a\n')]))
  await add('accepted_bom_manifest_text', rawBundle('\ufeff' + manifest([{ path: 'a.txt', mode: '100644' }]), [entry('files/a.txt', 'a\n')]))
  await add('accepted_json_whitespace', rawBundle(' \t\r\n[ {\r\n\t"path" : "a.txt" ,\n "mode":"100755" } ]\n\t', [entry('files/a.txt', '#!/bin/sh\n')]))
  await add('accepted_json_duplicate_key_last_wins', rawBundle('[{"path":"first.txt","path":"second.txt","mode":"100644"}]', [entry('files/second.txt', 'two\n')]))
  await add('accepted_json_escapes', rawBundle('[{"path":"\\u0061\\/b\\u00e9.txt","mode":"100644"},{"path":"\\ud83d\\ude00.txt","mode":"100644"}]', [entry('files/a/b\u00e9.txt', 'x\n'), entry('files/\ud83d\ude00.txt', 'y\n')]))
  await add('accepted_invalid_utf8_text', entrypointBundle([file('latin1.txt', new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]))]))
  {
    const late = new Uint8Array(9000).fill(0x61)
    late[8500] = 0
    await add('accepted_nul_after_sniff_window', entrypointBundle([file('late-nul.txt', late)]))
  }
  await add('accepted_bom_text_file', entrypointBundle([file('bom.txt', '\ufeffhello\n')]))
  await add('accepted_text_1000000', entrypointBundle([file('big.txt', repeat('a', 1_000_000))]))
  await add('accepted_binary_256000', entrypointBundle([file('big.bin', binaryOf(256_000))]))
  await add('accepted_50_binaries', entrypointBundle(Array.from({ length: 50 }, (_, i) => file(`bin/${String(i).padStart(2, '0')}.bin`, binaryOf(16, i)))))
  await add('accepted_1000_entries', entrypointBundle(Array.from({ length: 1000 }, (_, i) => ({ path: `del/${String(i).padStart(4, '0')}`, deleted: true as const }))))
  await add('accepted_docs_dotgithub_not_first', ok1('docs/.github/x.md'))
  await add('accepted_harness_as_file', ok1('.harness'))
  await add('accepted_dir_named_like_ci_file', ok1('.gitlab-ci.yml.d/x.txt'))
  await add('accepted_short_name_7_chars', ok1('abcdefg~1'))
  await add('accepted_short_name_astral_8_units', ok1('\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00~1'))
  await add('accepted_trailing_space_component', ok1('notes /a.txt'))
  await add('accepted_secret_near_misses', entrypointBundle([
    file('n1.txt', `xsk-${repeat('a', 30)}\n`),
    file('n2.txt', `sk-${repeat('a', 19)}\n`),
    file('n3.txt', `ghp_${repeat('A', 35)}\n`),
    file('n4.txt', `_ghp_${repeat('A', 36)}\n`),
    file('n5.txt', `-glpat-${repeat('a', 25)}\n`),
    file('n6.txt', `AKIA${repeat('A', 17)}\n`),
    file('n7.txt', `9AKIA${repeat('B', 16)}\n`),
    file('n8.txt', `AIza${repeat('a', 34)}\n`),
    file('n9.txt', `eyJ${repeat('a', 9)}.eyJ${repeat('b', 10)}.${repeat('c', 10)}\n`),
    file('n10.txt', '-----BEGIN PUBLIC KEY-----\n'),
    file('n11.txt', `sk_live_${repeat('a', 15)}\n`),
    file('n12.txt', `xoxb-${repeat('1', 9)}\n`),
    file('n13.txt', `kete_prod_${repeat('a', 30)}\n`),
    file('n14.txt', `github_pat_${repeat('a', 21)}\n`),
    file('n15.txt', 'sha 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n'),
  ]))

  // ---------------------------------------------------------------- manifest
  await add('manifest_not_first_file', tarGz([entry('files/a.txt', 'a\n'), mEntry([{ path: 'a.txt', mode: '100644' }])]))
  await add('manifest_not_first_empty_tar', tarGz([]))
  await add('manifest_not_first_prefixed_name', tarGz([entry('manifest.json', manifest([]), { prefix: 'x' })]))
  await add('manifest_not_first_nonutf8_name', tarGz([entry(new Uint8Array([0x6d, 0xff]), manifest([]))]))
  await add('manifest_invalid_not_json', rawBundle('[{"path":"a.txt",'))
  await add('manifest_invalid_object', rawBundle('{"path":"a.txt","mode":"100644"}'))
  await add('manifest_invalid_mode', rawBundle(manifest([{ path: 'a.txt', mode: '100664' }])))
  await add('manifest_invalid_mode_number', rawBundle('[{"path":"a.txt","mode":100644}]'))
  await add('manifest_invalid_extra_key', rawBundle(manifest([{ path: 'a.txt', mode: '100644', sha: 'x' }])))
  await add('manifest_invalid_deleted_false', rawBundle(manifest([{ path: 'a.txt', deleted: false }])))
  await add('manifest_invalid_mode_and_deleted', rawBundle(manifest([{ path: 'a.txt', mode: '100644', deleted: true }])))
  await add('manifest_invalid_empty_path', rawBundle(manifest([{ path: '', mode: '100644' }])))
  await add('manifest_invalid_key_case', rawBundle('[{"PATH":"a.txt","mode":"100644"}]'))
  await add('manifest_invalid_lone_surrogate_key', rawBundle('[{"pa\\ud800th":"a.txt","mode":"100644"}]'))
  await add('manifest_invalid_raw_nul', rawBundle('[{"path":"a.txt","mode":"100644"}]\u0000'))
  await add('manifest_invalid_utf8', tarGz([entry('manifest.json', new Uint8Array([0x5b, 0x22, 0xff, 0x22, 0x5d]))]))
  await add('manifest_invalid_trailing_comma', rawBundle('[{"path":"a.txt","mode":"100644"},]'))
  await add('manifest_invalid_vertical_tab', rawBundle('\u000b[]'))
  await add('manifest_invalid_single_quotes', rawBundle("[{'path':'a.txt','mode':'100644'}]"))
  await add('manifest_invalid_raw_control_in_string', rawBundle('[{"path":"a\tb","mode":"100644"}]'))
  await add('manifest_invalid_bad_escape', rawBundle('[{"path":"a\\x41","mode":"100644"}]'))
  await add('manifest_invalid_number_entry', rawBundle('[1]'))
  await add('manifest_invalid_null', rawBundle('null'))
  await add('manifest_invalid_empty', rawBundle(''))
  await add('too_many_entries_1001', rawBundle(manifest(Array.from({ length: 1001 }, (_, i) => ({ path: `d/${i}`, deleted: true })))))
  await add('too_many_entries_numbers', rawBundle(JSON.stringify(Array.from({ length: 1001 }, (_, i) => i))))
  await add('manifest_too_large', tarGz([entry('manifest.json', '[' + ' '.repeat(5_000_000 - 2) + ' ]')]))
  await add('accepted_manifest_5000000', tarGz([entry('manifest.json', '[' + ' '.repeat(5_000_000 - 2) + ']')]))
  await add('duplicate_path', withFiles(manifest([{ path: 'a.txt', mode: '100644' }, { path: 'a.txt', deleted: true }]), ['a.txt']))
  await add('ancestor_conflict', withFiles(manifest([{ path: 'a', mode: '100644' }, { path: 'a/b', mode: '100644' }]), ['a', 'a/b']))
  await add('ancestor_conflict_deleted_dir', withFiles(manifest([{ path: 'x/y', mode: '100644' }, { path: 'x', deleted: true }]), ['x/y']))

  // ---------------------------------------------------------------- paths
  for (const [name, path] of [
    ['invalid_path_absolute', '/abs.txt'],
    ['invalid_path_trailing_slash', 'dir/'],
    ['invalid_path_empty_component', 'a//b'],
    ['invalid_path_dot', './a'],
    ['invalid_path_dotdot', 'a/../b'],
    ['invalid_path_backslash', 'a\\b'],
    ['invalid_path_colon', 'c:d.txt'],
    ['invalid_path_tab', 'a\tb'],
    ['invalid_path_del', 'a\u007fb'],
    ['invalid_path_component_256', `dir/${repeat('n', 256)}`],
    ['invalid_path_component_256_multibyte', `dir/${repeat('\u00e9', 128)}`],
    ['invalid_path_nfd', 'cafe\u0301.txt'],
    ['invalid_path_dots_only', '.../a.txt'],
    ['invalid_path_dot_space', '. ./a.txt'],
    ['invalid_path_only_ignorable', '\u200d/a.txt'],
    ['protected_path_git', '.git/config'],
    ['protected_path_git_upper', '.GIT/config'],
    ['protected_path_git_trailing_dot', '.git./config'],
    ['protected_path_git_trailing_space', 'sub/.git /x'],
    ['protected_path_git_hfs_zwnj', '.g\u200cit/config'],
    ['protected_path_git_hfs_bom', '.git\ufeff/config'],
    ['protected_path_git_hfs_lre', '\u202a.git/config'],
    ['protected_path_git_hfs_iss', '.gi\u206at/config'],
    ['protected_path_kete_dir', 'a/.kete/agents.json'],
    ['protected_path_gitmodules', '.gitmodules'],
    ['protected_path_kete_json', 'pkg/kete.json'],
    ['protected_path_kete_jsonc', 'KETE.JSONC'],
    ['invalid_path_kelvin_sign_not_nfc', '\u212aete.json'],
    ['protected_path_short_git', 'GIT~1/config'],
    ['protected_path_short_hashed', 'GI7EBA~1/x'],
    ['protected_path_short_ext', 'a~1.txt'],
    ['protected_path_short_astral_6_units', '\ud83d\ude00\ud83d\ude00\ud83d\ude00~1'],
    ['protected_path_github', '.github/workflows/ci.yml'],
    ['protected_path_github_case', '.GitHub/x.md'],
    ['protected_path_github_file', '.github'],
    ['ci_path_gitlab', '.gitlab-ci.yml'],
    ['ci_path_gitlab_nested', 'sub/.gitlab-ci.yml'],
    ['ci_path_gitlab_case_dot', 'sub/.GITLAB-CI.YML.'],
    ['ci_path_circleci', '.circleci/config.yml'],
    ['ci_path_circleci_nested', 'a/.circleci/x/y.yml'],
    ['ci_path_harness', '.harness/pipeline.yaml'],
    ['ci_path_jenkinsfile', 'Jenkinsfile'],
    ['ci_path_jenkinsfile_upper', 'svc/JENKINSFILE'],
    ['ci_path_travis', '.travis.yml'],
    ['ci_path_azure', 'azure-pipelines.yml'],
    ['ci_path_azure_dir', '.azure-pipelines/x.yml'],
    ['ci_path_bitbucket', 'bitbucket-pipelines.yml'],
    ['ci_path_buildkite', '.buildkite/pipeline.yml'],
    ['ci_path_drone', '.drone.yml'],
    ['ci_path_woodpecker_dir', '.woodpecker/x.yml'],
    ['ci_path_woodpecker_file', '.woodpecker.yml'],
    ['ci_path_appveyor', 'appveyor.yml'],
    ['ci_path_cloudbuild', 'cloudbuild.yaml'],
    ['ci_path_teamcity', '.teamcity/settings.kts'],
  ] as const) {
    await add(name, ok1(path))
  }
  await add('invalid_path_deleted_entry', entrypointBundle([{ path: '../escape', deleted: true }]))
  await add('protected_path_deleted_entry', entrypointBundle([{ path: '.git/HEAD', deleted: true }]))
  await add('invalid_path_lone_surrogate', rawBundle('[{"path":"a\\ud800b","mode":"100644"}]'))
  await add('invalid_path_lone_low_surrogate', rawBundle('[{"path":"\\udc00","deleted":true}]'))
  await add('invalid_path_escaped_nul', rawBundle('[{"path":"a\\u0000b","deleted":true}]'))
  await add('case_collision_simple', entrypointBundle([file('README.md'), file('readme.md')]))
  await add('case_collision_directory', entrypointBundle([file('Src/a.ts'), file('src/b.ts')]))
  await add('case_collision_sharp_s', entrypointBundle([file('stra\u00dfe.txt'), file('STRASSE.txt')]))
  await add('invalid_path_kelvin_pair_not_nfc', entrypointBundle([file('\u212a.txt'), file('k.txt')]))
  await add('case_collision_final_sigma', entrypointBundle([file('\u03b1\u03c3.txt'), file('\u03b1\u03c2.txt')]))
  await add('case_collision_dotted_i', entrypointBundle([file('\u0130.txt'), file('i\u0307.txt')]))
  await add('case_collision_trailing_dot', entrypointBundle([file('dir./a.txt'), file('dir/b.txt')]))
  await add('accepted_zwsp_vs_zwnj', entrypointBundle([file('a\u200b.txt'), file('a\u200c.txt')]))
  await add('case_collision_hfs_ignorable', entrypointBundle([file('a\u200c.txt'), file('a.txt')]))
  await add('case_collision_ntfs_trailing_space', entrypointBundle([file('a.txt '), file('A.TXT')]))
  await add('accepted_zwsp_not_ignorable', entrypointBundle([file('a\u200b.txt')]))
  await add('accepted_ligature_ff', entrypointBundle([file('\ufb00.txt')]))
  await add('case_collision_ligature_ff', entrypointBundle([file('\ufb00.txt'), file('ff.txt')]))

  // ---------------------------------------------------------------- tar <-> manifest
  await add('outside_files', rawBundle(manifest([{ path: 'a.txt', mode: '100644' }]), [entry('other/a.txt', 'a\n')]))
  await add('unlisted_file', rawBundle(manifest([{ path: 'a.txt', mode: '100644' }]), [entry('files/a.txt', 'a\n'), entry('files/b.txt', 'b\n')]))
  await add('unlisted_file_empty_path', rawBundle(manifest([]), [entry('files/', 'a\n')]))
  await add('deleted_with_entry', rawBundle(manifest([{ path: 'a.txt', deleted: true }]), [entry('files/a.txt', 'a\n')]))
  await add('duplicate_entry', rawBundle(manifest([{ path: 'a.txt', mode: '100644' }]), [entry('files/a.txt', 'a\n'), entry('files/a.txt', 'a\n')]))
  await add('missing_file', rawBundle(manifest([{ path: 'a.txt', mode: '100644' }, { path: 'b.txt', mode: '100644' }]), [entry('files/a.txt', 'a\n')]))
  await add('invalid_path_nonutf8_entry_name', rawBundle(manifest([]), [entry(new Uint8Array([0x66, 0x69, 0x6c, 0x65, 0x73, 0x2f, 0xff]), 'a\n')]))
  await add('file_too_large', entrypointBundle([file('big.txt', repeat('a', 1_000_001))]))
  await add('binary_too_large', entrypointBundle([file('big.bin', binaryOf(256_001))]))
  await add('too_many_binaries', entrypointBundle(Array.from({ length: 51 }, (_, i) => file(`bin/${String(i).padStart(2, '0')}.bin`, binaryOf(16, i)))))

  // ---------------------------------------------------------------- secret shapes
  for (const [name, text] of [
    ['secret_openai', `key=sk-${repeat('a', 20)}`],
    ['secret_openai_proj_short_tail', `sk-proj-${repeat('a', 15)}`],
    ['secret_anthropic', `sk-ant-api03-${repeat('Z', 30)}`],
    ['secret_stripe', `sk_test_${repeat('9', 16)}`],
    ['secret_github_token', `ghs_${repeat('A', 36)}`],
    ['secret_github_pat', `github_pat_${repeat('a', 22)}`],
    ['secret_slack', `xoxp-${repeat('1', 10)}`],
    ['secret_aws_exact', `AKIA${repeat('A', 16)}`],
    ['secret_aws_lowercase_after', `AKIA${repeat('7', 16)}x`],
    ['secret_kete', `kete_live_${repeat('a', 20)}`],
    ['secret_gitlab', `glpat-${repeat('x', 20)}`],
    ['secret_google', `AIza${repeat('b', 35)}`],
    ['secret_jwt', `eyJ${repeat('a', 10)}.eyJ${repeat('b', 10)}.${repeat('c', 10)}`],
    ['secret_private_key', '-----BEGIN OPENSSH PRIVATE KEY-----'],
    ['secret_private_key_bare', '-----BEGIN PRIVATE KEY-----'],
    ['secret_after_multibyte', `\u00e9 sk-${repeat('q', 20)}`],
    ['secret_after_dot', `.ghp_${repeat('A', 36)}`],
  ] as const) {
    await add(name, entrypointBundle([file('clean.txt', 'nothing here\n'), file('s.txt', `${text}\n`)]))
  }
  await add('secret_in_binary', entrypointBundle([file('s.bin', concat([new Uint8Array([0, 1, 2]), enc.encode(`glpat-${repeat('x', 20)}`), new Uint8Array([0xff, 0xfe])]))]))
  await add('secret_in_invalid_utf8', entrypointBundle([file('s.txt', concat([new Uint8Array([0xe9, 0x20]), enc.encode(`AKIA${repeat('Q', 16)}`)]))]))

  // ---------------------------------------------------------------- gzip
  const good = entrypointBundle([file('a.txt', 'a\n')])
  const tarBytes = tarOf([mEntry([{ path: 'a.txt', mode: '100644' }]), entry('files/a.txt', 'a\n')])
  const { header, body, trailer } = gzParts(good)
  await add('bad_gzip_magic', concat([new Uint8Array([0x1f, 0x8c]), good.subarray(2)]))
  await add('bad_gzip_method', concat([new Uint8Array([0x1f, 0x8b, 7]), good.subarray(3)]))
  await add('bad_gzip_reserved_flag', concat([good.subarray(0, 3), new Uint8Array([0x20]), good.subarray(4)]))
  await add('bad_gzip_short', good.subarray(0, 17))
  await add('bad_gzip_not_gzip', enc.encode('this is not a gzip stream at all'))
  await add('bad_gzip_corrupt_deflate', concat([header, new Uint8Array([0xff, 0xff, 0xff, 0xff]), body.subarray(4), trailer]))
  await add('bad_gzip_crc', gzipWith(tarBytes, header, crc32(tarBytes) ^ 1))
  await add('bad_gzip_isize', gzipWith(tarBytes, header, undefined, tarBytes.length + 1))
  await add('truncated_gzip_trailer', good.subarray(0, good.length - 3))
  await add('truncated_gzip_no_trailer', good.subarray(0, good.length - 8))
  await add('bad_gzip_deflate_cut', good.subarray(0, 10 + Math.floor(body.length / 2)))
  await add('multi_member_gzip', concat([good, gzipSync(new Uint8Array(1024))]))
  await add('multi_member_gzip_magic_only', concat([good, new Uint8Array([0x1f, 0x8b])]))
  await add('trailing_data_after_gzip', concat([good, enc.encode('junk')]))
  await add('trailing_data_one_byte_magic', concat([good, new Uint8Array([0x1f])]))
  await add('trailing_data_zero_byte', concat([good, new Uint8Array([0])]))
  await add('accepted_gzip_header_fields', gzipWith(tarBytes, concat([new Uint8Array([0x1f, 0x8b, 8, 0x1e, 0, 0, 0, 0, 0, 3, 3, 0, 1, 2, 3]), enc.encode('name\u0000comment\u0000'), new Uint8Array([0xaa, 0xbb])])))
  await add('bad_gzip_unterminated_fname', concat([new Uint8Array([0x1f, 0x8b, 8, 0x08, 0, 0, 0, 0, 0, 3]), repeat('n', 30).split('').map((c) => c.charCodeAt(0)).reduce((a, c) => concat([a, new Uint8Array([c])]), new Uint8Array(0))]))

  // ---------------------------------------------------------------- tar structure
  const m1 = mEntry([{ path: 'a.txt', mode: '100644' }])
  const fa = entry('files/a.txt', 'a\n')
  await add('bad_checksum', tarGz([m1, entry('files/a.txt', 'a\n', { checksum: 1234 })]))
  await add('bad_header_magic', tarGz([m1, entry('files/a.txt', 'a\n', { magic: 'none' })]))
  await add('base256_size', tarGz([m1, entry('files/a.txt', 'a\n', { base256: true })]))
  for (const [name, type] of [['entry_type_dir', '5'], ['entry_type_symlink', '2'], ['entry_type_hardlink', '1'], ['entry_type_char', '3'], ['entry_type_block', '4'], ['entry_type_fifo', '6'], ['entry_type_contiguous', '7'], ['entry_type_sparse_gnu', 'S'], ['entry_type_volume', 'V']] as const) {
    await add(name, tarGz([m1, entry('files/a.txt', type === '5' ? '' : 'a\n', { type })]))
  }
  await add('pax_global', tarGz([paxHeader([paxRecord('path', 'x')], 'g', 'g'), m1, fa]))
  await add('pax_key', tarGz([m1, paxHeader([paxRecord('mtime', '0')]), fa]))
  await add('pax_key_linkpath', tarGz([m1, paxHeader([paxRecord('path', 'files/a.txt'), paxRecord('linkpath', 'x')]), fa]))
  await add('sparse_pax_key', tarGz([m1, paxHeader([paxRecord('GNU.sparse.size', '10')]), fa]))
  await add('bad_extension_pax_twice', tarGz([m1, paxHeader([paxRecord('path', 'files/a.txt'), paxRecord('path', 'files/a.txt')]), fa]))
  await add('bad_extension_pax_empty_value', tarGz([m1, paxHeader([paxRecord('path', '')]), fa]))
  await add('bad_extension_pax_nul_value', tarGz([m1, paxHeader([paxRecord('path', 'files/a\u0000.txt')]), fa]))
  await add('bad_extension_pax_bad_length', tarGz([m1, paxHeader([enc.encode('99 path=files/a.txt\n')]), fa]))
  await add('bad_extension_pax_leading_zero', tarGz([m1, paxHeader([enc.encode('022 path=files/a.txt\n')]), fa]))
  await add('bad_extension_pax_no_equals', tarGz([m1, paxHeader([enc.encode('9 nopath\n')]), fa]))
  await add('bad_extension_pax_size_zero', tarGz([m1, entry('PaxHeaders.0/x', '', { type: 'x' }), fa]))
  await add('bad_extension_pax_too_large', tarGz([m1, paxHeader([paxRecord('path', repeat('p', 8200))]), fa]))
  await add('bad_extension_gnu_junk_after_nul', tarGz([m1, entry('././@LongLink', 'files/a.txt\u0000x', { type: 'L', magic: 'gnu' }), entry('t', 'a\n', { magic: 'gnu' })]))
  await add('bad_extension_gnu_empty_name', tarGz([m1, entry('././@LongLink', '\u0000', { type: 'L', magic: 'gnu' }), entry('t', 'a\n', { magic: 'gnu' })]))
  await add('double_extension', tarGz([m1, paxHeader([paxRecord('path', 'files/a.txt')]), entry('././@LongLink', 'files/a.txt\u0000', { type: 'L', magic: 'gnu' }), fa]))
  await add('dangling_extension', tarGz([m1, fa, paxHeader([paxRecord('path', 'files/b.txt')])]))
  await add('gnu_long_link', tarGz([m1, entry('././@LongLink', 'target\u0000', { type: 'K', magic: 'gnu' }), fa]))
  await add('trailing_data_after_tar_end', tarGz([m1, fa, END, entry('files/b.txt', 'b\n')], { end: false }))
  await add('accepted_minimal', tarGz([m1, fa]))
  await add('bad_header_second_end_block', tarGz([m1, fa, new Uint8Array(512), entry('files/b.txt', 'b\n')], { end: false }))
  await add('truncated_no_end', tarGz([m1, fa], { end: false }))
  await add('truncated_one_end_block', tarGz([m1, fa, new Uint8Array(512)], { end: false }))
  await add('truncated_mid_data', new Uint8Array(gzipSync(concat([m1, tarHeader({ name: 'files/a.txt', size: 2000 }), new Uint8Array(100)]))))
  await add('truncated_partial_block', new Uint8Array(gzipSync(concat([m1, fa, END, new Uint8Array(0)]).subarray(0, m1.length + 300))))
  {
    const h = tarHeader({ name: 'files/a.txt', size: 2 })
    h.set(enc.encode('00000000x02\u0000'), 124)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!
    h.set(enc.encode(sum.toString(8).padStart(6, '0') + '\u0000 '), 148)
    await add('bad_header_size_garbage', tarGz([m1, h, enc.encode('a\n'.padEnd(512, '\u0000'))]))
    const s = tarHeader({ name: 'files/a.txt', size: 2 })
    s.set(enc.encode('         2 \u0000'), 124)
    sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : s[i]!
    s.set(enc.encode(sum.toString(8).padStart(6, '0') + '\u0000 '), 148)
    await add('accepted_size_leading_spaces', tarGz([m1, s, enc.encode('a\n'.padEnd(512, '\u0000'))]))
    const z = tarHeader({ name: 'files/a.txt', size: 2 })
    z.set(new Uint8Array(12), 124)
    sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : z[i]!
    z.set(enc.encode(sum.toString(8).padStart(6, '0') + '\u0000 '), 148)
    await add('bad_header_size_empty', tarGz([m1, z, new Uint8Array(512)]))
  }

  // ---------------------------------------------------------------- decompressed size
  {
    // n files of 1,000,000 'a' bytes; each entry is 512 + 1,000,448 bytes.
    const files = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `f/${String(i).padStart(2, '0')}`, mode: '100644' as const }))
    const fileEntries = (n: number) => files(n).map((f) => goEntry(`files/${f.path}`, enc.encode(repeat('a', 1_000_000))))
    await add('accepted_19_megabytes', tarGz([goEntry('manifest.json', enc.encode(manifest(files(19)))), ...fileEntries(19)]))
    await add('decompressed_too_large', tarGz([goEntry('manifest.json', enc.encode(manifest(files(21)))), ...fileEntries(21)]))
    // A bad header block placed in the 64 KiB inflate chunk that crosses 20,000,000 bytes (Node
    // counts the chunk before the tar reader sees it) and one placed in the chunk before.
    const placed = (target: number) => {
      const head = goEntry('manifest.json', enc.encode(manifest([...files(19), { path: 'pad', mode: '100644' }])))
      const fixed = concat([head, ...fileEntries(19)])
      const padEntry = target - fixed.length - 512
      if (padEntry < 0 || padEntry % 512 !== 0) throw new Error(`bad target ${target}`)
      const pad = goEntry('files/pad', enc.encode(repeat('b', padEntry)))
      const bad = tarHeader({ name: 'files/zz', size: 1, checksum: 1 })
      const raw = concat([fixed, pad, bad, new Uint8Array(200_000)])
      if (fixed.length + pad.length !== target) throw new Error('offset')
      return new Uint8Array(gzipSync(raw))
    }
    await add('decompressed_too_large_wins_in_crossing_chunk', placed(39043 * 512))
    await add('bad_checksum_in_chunk_before_cap', placed(38868 * 512))
  }

  const h = createHash('sha256')
  for (const c of cases) h.update(c.name).update(c.bundle_b64)
  const out = {
    description:
      "Change-bundle validation vectors: each bundle with the result of kete-code-platform's validateBundle (apps/portal/lib/jobs/bundle/validate.ts) on Node. Generated by packages/kete-job-host/testdata/bundle-v1/generate.ts; never edit by hand. bundle_too_large (over 10,000,000 compressed bytes) is not stored here (size); the Go unit tests cover it.",
    platform_commit: process.env.KETE_PLATFORM_COMMIT ?? 'unknown',
    runtime: `node ${process.version}`,
    cases_digest: h.digest('hex'),
    cases,
  }
  process.stdout.write(JSON.stringify(out, null, 1) + '\n')
}

await main()
