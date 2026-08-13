#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TRANSACTION_CONTROL = /^(?:begin\b|start\s+transaction\b|commit\b|end\b|rollback\b|abort\b|savepoint\b|release(?:\s+savepoint)?\b|prepare\s+transaction\b|set\s+transaction\b)/i;

function normalizedPreview(statement) {
  return statement.replace(/\s+/g, ' ').trim().slice(0, 160);
}

export function findTopLevelTransactionControl(source) {
  const hits = [];
  let i = 0;
  let line = 1;
  let statementLine = 1;
  let statement = '';

  function append(value) {
    if (statement.trim() === '' && value.trim() !== '') statementLine = line;
    statement += value;
  }

  function finishStatement() {
    const preview = normalizedPreview(statement);
    if (TRANSACTION_CONTROL.test(preview)) {
      hits.push({ line: statementLine, statement: preview });
    }
    statement = '';
  }

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '-' && next === '-') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i += 1;
      append(' ');
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        if (source[i] === '\n') line += 1;
        if (source[i] === '/' && source[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (source[i] === '*' && source[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      append(' ');
      continue;
    }

    if (ch === "'") {
      append("''");
      i += 1;
      while (i < source.length) {
        if (source[i] === '\n') line += 1;
        if (source[i] === "'" && source[i + 1] === "'") {
          i += 2;
        } else if (source[i] === "'") {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      continue;
    }

    if (ch === '"') {
      append('""');
      i += 1;
      while (i < source.length) {
        if (source[i] === '\n') line += 1;
        if (source[i] === '"' && source[i + 1] === '"') {
          i += 2;
        } else if (source[i] === '"') {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      continue;
    }

    if (ch === '$') {
      const delimiter = source.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (delimiter) {
        const bodyStart = i + delimiter.length;
        const bodyEnd = source.indexOf(delimiter, bodyStart);
        if (bodyEnd === -1) throw new Error(`unterminated dollar-quoted body at line ${line}`);
        const body = source.slice(bodyStart, bodyEnd);
        line += (body.match(/\n/g) || []).length;
        append(' $body$ ');
        i = bodyEnd + delimiter.length;
        continue;
      }
    }

    if (ch === ';') {
      finishStatement();
      i += 1;
      continue;
    }

    append(ch);
    if (ch === '\n') line += 1;
    i += 1;
  }

  finishStatement();
  return hits;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: find-top-level-transaction-control.mjs <migration.sql>');
    process.exit(2);
  }

  try {
    const hits = findTopLevelTransactionControl(readFileSync(file, 'utf8'));
    for (const hit of hits) console.log(`${hit.line}\t${hit.statement}`);
    process.exit(hits.length > 0 ? 1 : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
