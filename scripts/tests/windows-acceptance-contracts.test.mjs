import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

test('ordinary-laptop model and Windows CPU runtime remain exactly pinned', () => {
  const models = read('web-app/src/constants/yorebot-models.ts')
  const backends = read('extensions/llamacpp-upstream-extension/src/backend.ts')

  for (const value of [
    "id: 'Qwen3.5-9B-Q4_K_M'",
    "repository: 'unsloth/Qwen3.5-9B-GGUF'",
    "revision: '3885219b6810b007914f3a7950a8d1b469d598a5'",
    "filename: 'Qwen3.5-9B-Q4_K_M.gguf'",
    'sizeBytes: 5_680_522_464',
    "sha256: '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8'",
  ]) {
    assert.ok(models.includes(value), `missing model pin: ${value}`)
  }

  for (const value of [
    "version: 'b10431'",
    "backend: 'win-cpu-x64'",
    "filename: 'llama-b10431-bin-win-cpu-x64.zip'",
    'size: 18_462_983',
    "sha256: 'aa16a2102de8730be6079f67f77997ca549e9a07125563571afb2fb4e810ec2c'",
  ]) {
    assert.ok(backends.includes(value), `missing backend pin: ${value}`)
  }
})

test('disabled public updater is not registered during desktop startup', () => {
  const app = read('src-tauri/src/lib.rs')
  const config = JSON.parse(read('src-tauri/tauri.conf.json'))

  assert.doesNotMatch(app, /plugin\(tauri_plugin_updater::/)
  assert.equal(config.bundle.createUpdaterArtifacts, false)
  assert.equal(Object.hasOwn(config.plugins, 'updater'), false)
})

test('installer smoke owns exact processes and protects prefix siblings', () => {
  const script = read('scripts/test-windows-installer.ps1')
  const hooks = read('src-tauri/windows/hooks.nsh')

  for (const value of [
    "'YoreBotTools'",
    "-Name 'llama-server'",
    "-Name 'bun'",
    "-Name 'uv'",
    'Get-ProcessesAtExactPath',
    'Stop-Process -Id',
    '-WorkingDirectory $installRoot',
    '-RedirectStandardOutput $appStdoutPath',
    '-RedirectStandardError $appStderrPath',
    'Write-LaunchDiagnostics',
    'YoreBot exited during startup with exit code',
    'Bundled llama.cpp backend ready during startup: b10431/win-cpu-x64',
    'did not report its exact bundled backend ready',
    "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\YoreBot'",
    'use a fresh Windows runner',
    'Uninstaller touched sibling sentinel',
  ]) {
    assert.ok(script.includes(value), `missing installer guard: ${value}`)
  }
  assert.doesNotMatch(script, /Stop-Process\s+-Name/i)
  assert.doesNotMatch(script, /taskkill/i)
  assert.doesNotMatch(script, /if\s*\(\$launchedApp\.ExitCode/i)
  assert.doesNotMatch(script, /exited cleanly/i)
  assert.ok(
    script.indexOf('Stop-ExactProcesses -Path $appPath') <
      script.indexOf('$launchedApp = Start-Process')
  )
  assert.ok(
    script.indexOf('New-Item -ItemType Directory -Path $installSibling, $dataSibling') <
      script.indexOf("Join-Path $installSibling 'keep.txt'")
  )
  assert.doesNotMatch(hooks, /\$INSTDIR\*/)
  assert.doesNotMatch(hooks, /\$APPDATA\\YoreBot\*/)
  assert.match(hooks, /\.StartsWith\(/)
  assert.match(hooks, /\[char\]92/)
})

test('model smoke verifies both downloads before an exact outbound block and loopback request', () => {
  const script = read('scripts/test-windows-pinned-model.ps1')
  const backendDownload = script.indexOf('Invoke-PinnedDownload -Url $backendUrl')
  const modelDownload = script.indexOf('Invoke-PinnedDownload -Url $modelUrl')
  const firewall = script.indexOf('New-NetFirewallRule')
  const serverStart = script.indexOf('Start-Process -FilePath $serverPath')
  const prompt = script.indexOf('/v1/chat/completions')

  assert.ok(backendDownload >= 0 && modelDownload > backendDownload)
  assert.ok(firewall > modelDownload)
  assert.ok(serverStart > firewall)
  assert.ok(prompt > serverStart)
  assert.match(script, /-Program \$serverPath/)
  assert.match(script, /--host', '127\.0\.0\.1'/)
  assert.match(script, /Pinned model returned an empty response/)
  assert.match(script, /\$backendUrl = "https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download/)
  assert.match(script, /sha256:\\s\*'\[0-9a-f\]\{64\}'/)
  assert.doesNotMatch(script, /Get-StringField \$backendBlock 'url'/)
  assert.match(script, /\.PSObject\.Properties\['content'\]/)
  assert.match(script, /\.PSObject\.Properties\['reasoning_content'\]/)
  assert.doesNotMatch(script, /tokens?\s*(\/|per)\s*second|throughput|benchmark/i)
  assert.doesNotMatch(script, /Stop-Process\s+-Name/i)
})

test('heavy model smoke is manual-only while installer smoke stays on PR builds', () => {
  const internal = read('.github/workflows/windows-internal.yml')
  const installerUpload = internal.indexOf('- uses: actions/upload-artifact@v4')
  const installerSmoke = internal.indexOf('- name: Smoke fresh NSIS install and uninstall')

  assert.match(internal, /^\s*pull_request:\s*$/m)
  assert.match(internal, /test-windows-installer\.ps1/)
  assert.match(internal, /node --test scripts\/tests\/windows-acceptance-contracts\.test\.mjs/)
  assert.match(internal, /test-windows-pinned-model\.ps1 -ValidateManifestOnly/)
  assert.match(
    internal,
    /tauri-plugin-llamacpp-upstream\/Cargo\.toml test_parse_binary_version/
  )
  assert.ok(installerUpload >= 0 && installerUpload < installerSmoke)
  assert.match(internal.slice(installerUpload, installerSmoke), /if: always\(\)/)
  assert.match(internal, /^\s{2}pinned-model-smoke:\s*$/m)
  assert.match(internal, /^\s{4}if: github\.event_name == 'workflow_dispatch'\s*$/m)
  assert.match(internal, /^\s*\.\/scripts\/test-windows-pinned-model\.ps1\b/m)
  assert.equal(
    existsSync(resolve(root, '.github/workflows/windows-pinned-model-smoke.yml')),
    false
  )
})
