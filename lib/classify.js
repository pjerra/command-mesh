'use strict';

// Shared tool-name classification: tool name -> station.
// Case-insensitive on the tool name; input text only used for memory/skills path rules.

const SHELL_RE = /bash|shell|exec|terminal|command|eval|monitor|killshell/;
const FILES_RE = /read|write|edit|glob|grep|find|ls|notebook|patch|file/;
const WEB_RE = /webfetch|websearch|web_|fetch|http|search_query/;
const BROWSER_RE = /browser|playwright|puppeteer|chrome/;
const AGENTS_RE = /agent|task|subagent|sendmessage|workflow|spawn|wait_agent/;

function hasPathField(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['file_path', 'path']) {
    if (typeof input[key] === 'string' && input[key]) return input[key];
  }
  return '';
}

function classify(tool, input) {
  const name = String(tool || '');
  const lower = name.toLowerCase();
  const pathField = hasPathField(input);
  const lowerPath = String(pathField).toLowerCase();

  if (lowerPath.includes('/memory/') || /memory|remember|recall/.test(lower)) return 'memory';
  if (lower.includes('skill')) return 'skills';
  if (input && typeof input === 'object' && typeof input.skill === 'string' && input.skill) return 'skills';
  if (lowerPath.includes('/skills/') || /skill\.md/i.test(pathField)) return 'skills';
  if (lower === 'todo') return 'model';
  if (lower === 'wait') return 'agents';
  if (AGENTS_RE.test(lower)) return 'agents';
  if (BROWSER_RE.test(lower)) return 'browser';
  if (WEB_RE.test(lower)) return 'web';
  if (FILES_RE.test(lower)) return 'files';
  if (SHELL_RE.test(lower)) return 'shell';
  return 'model';
}

function firstWordBasename(command) {
  const first = String(command).trim().split(/\s+/)[0] || '';
  return first.split('/').pop();
}

function shellCommandOf(input) {
  if (input && typeof input === 'object' && typeof input.command === 'string') return input.command;
  if (typeof input === 'string') return input;
  return '';
}

function lastTwoSegments(p) {
  let s = String(p).replace(/:[\d,\-:]+$/, '');
  s = s.replace(/\/+$/, '');
  const parts = s.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function shortLabel(tool, input) {
  const name = String(tool || '');
  const lower = name.toLowerCase();
  if (SHELL_RE.test(lower)) {
    const word = firstWordBasename(shellCommandOf(input));
    return word ? `${name} ${word}`.slice(0, 100) : name;
  }
  if (lower.startsWith('mcp__')) {
    const rest = name.split('__').slice(1);
    const label = rest.length >= 2 ? `${rest[0]}:${rest.slice(1).join('__')}` : rest.join(':');
    return (label || name).slice(0, 100);
  }
  if (input && typeof input === 'object') {
    if (lower === 'skill' && typeof input.skill === 'string' && input.skill) {
      return `Skill ${input.skill}`.slice(0, 100);
    }
    if ((lower === 'agent' || lower === 'task') && typeof input.subagent_type === 'string' && input.subagent_type) {
      return `${name} ${input.subagent_type}`.slice(0, 100);
    }
    const pathField = hasPathField(input);
    if (pathField) return `${name} ${lastTwoSegments(pathField)}`.slice(0, 100);
  }
  return name.slice(0, 100);
}

// Upstream Codex helpers (from extension.js): classify on name+input text, short fixed labels.
function classifyCodexTool(name, input) {
  const lower = `${name} ${input}`.toLowerCase();
  if (/(spawn_agent|followup_task|send_message|wait_agent|collaboration\.)/.test(lower)) return 'agents';
  if (/(skill\.md|[\\/]skills[\\/])/.test(lower)) return 'skills';
  if (/(playwright-cli|cua_repl|createbrowsertab|gettab\s*\()/.test(lower)) return 'browser';
  if (/(web__run|tools\.web|search_query|image_query|web_fetch|fetch\s*\()/.test(lower)) return 'web';
  if (/(command-mesh-hook|lot-map-hook|[\\/]hook\.js)/.test(lower)) return 'hooks';
  if (/(memory|remember|recall)/.test(lower)) return 'memory';
  if (/(apply_patch|read|write|edit|file|glob|grep)/.test(lower)) return 'files';
  if (/(shell|terminal|command|bash|powershell|exec|run)/.test(lower)) return 'shell';
  return 'model';
}

function codexToolLabel(tool, station) {
  if (station === 'web') return 'web request';
  if (station === 'browser') return 'browser automation';
  if (station === 'skills') return 'skill loaded';
  if (station === 'hooks') return 'telemetry hook';
  return tool;
}

module.exports = { classify, shortLabel, classifyCodexTool, codexToolLabel };
