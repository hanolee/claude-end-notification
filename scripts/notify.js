#!/usr/bin/env node
'use strict';

/**
 * claude-end-notification — cross-platform system notification dispatcher.
 *
 * Invoked by Claude Code hooks. The hook payload arrives as JSON on stdin and
 * the event kind is argv[2]: "stop" | "notification".
 *
 * Contract: this script must NEVER write to stdout (Claude Code would try to
 * parse stdout as hook JSON) and must always exit 0 — a notification failure
 * should never block or error a Claude turn. Debug output goes to stderr and
 * is gated behind the CEN_DEBUG env var.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const DEBUG = !!process.env.CEN_DEBUG;
function debug() {
  if (!DEBUG) return;
  console.error('[claude-end-notification]', ...arguments);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
const PLUGIN_DATA =
  process.env.CLAUDE_PLUGIN_DATA ||
  path.join(os.homedir(), '.claude', 'plugin-data', 'claude-end-notification');
const STATE_DIR = path.join(PLUGIN_DATA, 'state');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  enabled: true,
  events: { stop: true, notification: true },
  notificationTypes: {
    permission_prompt: true,
    idle_prompt: true,
    elicitation_dialog: true,
    elicitation_complete: false,
    elicitation_response: false,
    auth_success: false,
  },
  sound: 'default',
  skipWhenFocused: false,
  focusedApps: [
    'Terminal', 'iTerm2', 'iTerm', 'WezTerm', 'Ghostty', 'Alacritty', 'kitty',
    'Code', 'WindowsTerminal', 'powershell', 'pwsh', 'cmd',
  ],
  cooldownSeconds: 0,
  macBackend: 'auto', // auto | osascript | terminal-notifier
  winBackend: 'auto', // auto | powershell | burnttoast
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  if (!isPlainObject(override)) return base;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const key of Object.keys(override)) {
    if (isPlainObject(base[key]) && isPlainObject(override[key])) {
      out[key] = deepMerge(base[key], override[key]);
    } else {
      out[key] = override[key];
    }
  }
  return out;
}

function loadConfig() {
  const candidates = [
    path.join(PLUGIN_DATA, 'config.json'),
    path.join(PLUGIN_ROOT, 'config.json'),
    path.join(PLUGIN_ROOT, 'config.example.json'),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        debug('loaded config from', file);
        return deepMerge(DEFAULT_CONFIG, parsed);
      }
    } catch (e) {
      debug('failed to read config', file, e.message);
    }
  }
  return DEFAULT_CONFIG;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
function readPayload() {
  let raw = '';
  try {
    // Hooks always pipe stdin, so fd 0 is a readable pipe here.
    raw = fs.readFileSync(0, 'utf8');
  } catch (e) {
    debug('could not read stdin:', e.message);
  }
  try {
    return JSON.parse(raw || '{}');
  } catch (e) {
    debug('could not parse stdin JSON:', e.message);
    return {};
  }
}

// ---------------------------------------------------------------------------
// State (cooldown timestamps)
// ---------------------------------------------------------------------------
function safeSessionId(payload) {
  return String(payload.session_id || 'default').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function stateFile(payload, suffix) {
  return path.join(STATE_DIR, safeSessionId(payload) + '.' + suffix);
}

function readStamp(file) {
  try {
    return parseInt(fs.readFileSync(file, 'utf8'), 10) || 0;
  } catch (e) {
    return 0;
  }
}

function writeStamp(file) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(file, String(Date.now()));
  } catch (e) {
    debug('writeStamp failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Focus detection (only used when config.skipWhenFocused is true)
// ---------------------------------------------------------------------------
function frontmostApp() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync(
        'osascript',
        ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
        { timeout: 2000, encoding: 'utf8' }
      );
      return out.trim();
    }
    if (process.platform === 'win32') {
      const script = [
        'Add-Type @"',
        'using System;using System.Runtime.InteropServices;',
        'public class CenFg{',
        '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
        '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);}',
        '"@',
        '$procId = 0',
        '[void][CenFg]::GetWindowThreadProcessId([CenFg]::GetForegroundWindow(), [ref]$procId)',
        '(Get-Process -Id $procId).ProcessName',
      ].join('\n');
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { timeout: 3000, encoding: 'utf8', windowsHide: true }
      );
      return out.trim();
    }
  } catch (e) {
    debug('frontmostApp failed:', e.message);
  }
  return '';
}

function terminalIsFocused(config) {
  const app = frontmostApp().toLowerCase();
  if (!app) return false;
  return (config.focusedApps || []).some(function (a) {
    return String(a).toLowerCase() === app;
  });
}

// ---------------------------------------------------------------------------
// Message building
// ---------------------------------------------------------------------------
function projectName(payload) {
  const cwd = payload && payload.cwd;
  if (!cwd) return 'Claude Code';
  return path.basename(String(cwd)) || String(cwd);
}

function buildMessage(eventKind, payload) {
  const proj = projectName(payload);

  if (eventKind === 'stop') {
    if (payload.stop_reason === 'max_tokens') {
      return { title: '⚠️ Claude Code · ' + proj, body: '토큰 한도로 응답이 중단됐어요' };
    }
    return { title: '✅ Claude Code · ' + proj, body: '작업을 마쳤어요' };
  }

  // notification
  const type = payload.notification_type;
  const data = payload.notification_data || {};
  switch (type) {
    case 'permission_prompt': {
      const tool = data.tool_name ? data.tool_name + ' ' : '';
      return { title: '🔐 Claude Code · ' + proj, body: tool + '실행 권한을 기다리는 중이에요' };
    }
    case 'idle_prompt':
      return { title: '💬 Claude Code · ' + proj, body: '입력을 기다리고 있어요' };
    case 'elicitation_dialog':
      return { title: '❓ Claude Code · ' + proj, body: 'Claude가 질문을 했어요' };
    case 'auth_success':
      return { title: '🔑 Claude Code · ' + proj, body: '인증이 완료됐어요' };
    default:
      return { title: '💬 Claude Code · ' + proj, body: '확인이 필요해요' };
  }
}

// ---------------------------------------------------------------------------
// OS notification backends
// ---------------------------------------------------------------------------
function commandExists(cmd) {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(probe, [cmd], { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch (e) {
    return false;
  }
}

function dispatch(cmd, args) {
  return new Promise(function (resolve) {
    try {
      execFile(cmd, args, { timeout: 8000, windowsHide: true }, function (err) {
        if (err) debug('notifier error:', cmd, err.message);
        resolve();
      });
    } catch (e) {
      debug('dispatch threw:', e.message);
      resolve();
    }
  });
}

function escAppleScript(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escPwsh(s) {
  return String(s).replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '`"');
}

function notifyMac(msg, config) {
  const useTN =
    config.macBackend === 'terminal-notifier' ||
    (config.macBackend === 'auto' && commandExists('terminal-notifier'));

  if (useTN) {
    const args = ['-title', msg.title, '-message', msg.body];
    if (config.sound && config.sound !== 'none') {
      args.push('-sound', config.sound === 'default' ? 'default' : config.sound);
    }
    const icon = path.join(PLUGIN_ROOT, 'assets', 'icon.png');
    if (fs.existsSync(icon)) args.push('-appIcon', icon);
    debug('backend: terminal-notifier');
    return dispatch('terminal-notifier', args);
  }

  let script =
    'display notification "' + escAppleScript(msg.body) +
    '" with title "' + escAppleScript(msg.title) + '"';
  if (config.sound && config.sound !== 'none') {
    const name = config.sound === 'default' ? 'Ping' : config.sound;
    script += ' sound name "' + escAppleScript(name) + '"';
  }
  debug('backend: osascript');
  return dispatch('osascript', ['-e', script]);
}

function notifyWindows(msg, config) {
  const allowBurnt = config.winBackend === 'burnttoast' || config.winBackend === 'auto';
  const title = escPwsh(msg.title);
  const body = escPwsh(msg.body);
  const silent = !config.sound || config.sound === 'none';

  // One PowerShell script that prefers BurntToast and falls back to a native
  // toast — keeps backend detection out of Node and avoids an extra spawn.
  const lines = [
    '$ErrorActionPreference = "Stop"',
    '$title = "' + title + '"',
    '$body  = "' + body + '"',
    '$tryBurnt = ' + (allowBurnt ? '$true' : '$false'),
    'if ($tryBurnt -and (Get-Module -ListAvailable -Name BurntToast)) {',
    '  Import-Module BurntToast -ErrorAction SilentlyContinue',
    '  ' + (silent
      ? 'New-BurntToastNotification -Text $title,$body -Silent'
      : 'New-BurntToastNotification -Text $title,$body'),
    '} else {',
    '  [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null',
    '  $tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    '  $texts = $tpl.GetElementsByTagName("text")',
    '  $texts.Item(0).AppendChild($tpl.CreateTextNode($title)) | Out-Null',
    '  $texts.Item(1).AppendChild($tpl.CreateTextNode($body)) | Out-Null',
    silent
      ? '  $audio = $tpl.CreateElement("audio"); $audio.SetAttribute("silent","true"); $tpl.DocumentElement.AppendChild($audio) | Out-Null'
      : '  # default toast sound',
    '  $toast = [Windows.UI.Notifications.ToastNotification]::new($tpl)',
    '  $appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"',
    '  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)',
    '}',
  ];
  const encoded = Buffer.from(lines.join('\n'), 'utf16le').toString('base64');
  debug('backend: powershell (BurntToast if available)');
  return dispatch('powershell', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
  ]);
}

function notifyLinux(msg) {
  if (!commandExists('notify-send')) {
    debug('notify-send not found — skipping');
    return Promise.resolve();
  }
  debug('backend: notify-send');
  return dispatch('notify-send', ['--app-name=Claude Code', msg.title, msg.body]);
}

function notify(msg, config) {
  if (process.platform === 'darwin') return notifyMac(msg, config);
  if (process.platform === 'win32') return notifyWindows(msg, config);
  return notifyLinux(msg);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const eventKind = process.argv[2] || '';
  if (eventKind !== 'stop' && eventKind !== 'notification') {
    debug('unknown event kind:', eventKind);
    return Promise.resolve();
  }

  const payload = readPayload();
  const config = loadConfig();

  if (!config.enabled) {
    debug('plugin disabled');
    return Promise.resolve();
  }
  if (!config.events || config.events[eventKind] === false) {
    debug('event disabled:', eventKind);
    return Promise.resolve();
  }

  // Per-type filter for Notification events.
  if (eventKind === 'notification') {
    const type = payload.notification_type;
    if (type && config.notificationTypes && config.notificationTypes[type] === false) {
      debug('notification type disabled:', type);
      return Promise.resolve();
    }
  }

  // Skip if the user is already looking at a terminal window.
  if (config.skipWhenFocused && terminalIsFocused(config)) {
    debug('terminal focused — skipping');
    return Promise.resolve();
  }

  // Cooldown throttles repeated Stop notifications; questions/permissions are
  // never throttled.
  if (eventKind === 'stop' && config.cooldownSeconds > 0) {
    const lastFile = stateFile(payload, 'last');
    const last = readStamp(lastFile);
    if (last > 0 && (Date.now() - last) / 1000 < config.cooldownSeconds) {
      debug('within cooldown window — skipping');
      return Promise.resolve();
    }
    writeStamp(lastFile);
  }

  const msg = buildMessage(eventKind, payload);
  debug('notify:', msg.title, '/', msg.body);
  return notify(msg, config);
}

main()
  .then(function () { process.exit(0); })
  .catch(function (e) {
    debug('main error:', e && e.message);
    process.exit(0);
  });
