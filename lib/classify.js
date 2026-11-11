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

const SHELL_WRAPPERS = new Set(['sudo', 'nice', 'env', 'time']);

// Index just past an assignment's value that starts at `from`, or -1 when the value does not end
// cleanly (open quote, open $( or backtick). A value may hold quotes and command substitutions with
// spaces in them, so it is scanned, never split on whitespace: a word from inside it must not
// become the label.
function assignmentEnd(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let close = i + 1;
      while (close < text.length && text[close] !== c) close += c !== "'" && text[close] === '\\' ? 2 : 1;
      if (close >= text.length) return -1;
      i = close;
      continue;
    }
    if (c === '(') { depth++; continue; }
    if (c === ')') { if (depth === 0) return -1; depth--; continue; }
    if (depth === 0 && (c === ';' || /\s/.test(c))) return i;
  }
  return depth === 0 ? text.length : -1;
}

function firstShellWord(command) {
  let rest = String(command).trim();
  for (;;) {
    const assign = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=/);
    if (assign) {
      const end = assignmentEnd(rest, assign[0].length);
      if (end < 0) return '';
      rest = rest.slice(end).replace(/^[\s;]+/, '');
      continue;
    }
    const cd = rest.match(/^cd\s+\S+(?:\s*&&\s*|\s*;\s*)/);
    if (cd) {
      rest = rest.slice(cd[0].length).trim();
      continue;
    }
    const wrapper = rest.match(/^(sudo|nice|env|time)(?:\s+|$)/);
    if (wrapper && SHELL_WRAPPERS.has(wrapper[1])) {
      rest = rest.slice(wrapper[0].length).trim();
      continue;
    }
    break;
  }
  if (!rest) return '';
  let word = rest.split(/\s+/)[0] || '';
  word = word.replace(/;$/, '');
  if ((word.startsWith('"') && word.endsWith('"') && word.length >= 2) ||
    (word.startsWith("'") && word.endsWith("'") && word.length >= 2)) {
    return '';
  }
  const base = word.split('/').pop();
  return /^[A-Za-z0-9_.+-]{1,40}$/.test(base) ? base : '';
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
    const word = firstShellWord(shellCommandOf(input));
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
