'use strict';

const assert = require('assert');

process.env.APP_URL = 'https://example.com';
process.env.KIE_API_KEY = 'test-key';

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === './session.service') return { getOrCreateSession: async () => ({ containerId: 'c1' }) };
  if (request === './docker.service') return { executeInContainer: async () => ({ stdout: '' }) };
  if (request === '../config') return { APP_URL: 'https://example.com', DATA_ROOT: '/tmp' };
  return originalLoad.call(this, request, ...args);
};

const { _parseFiles } = require('../services/inputImageContext.service');

Module._load = originalLoad;

const colors = { green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', reset: '\x1b[0m' };
let passed = 0, failed = 0;
const errors = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ${colors.green}✓${colors.reset} ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ${colors.red}✗${colors.reset} ${name}: ${e.message}`);
    errors.push({ name, error: e.message });
    failed++;
  }
}

function group(name) { console.log(`\n${colors.yellow}${name}${colors.reset}`); }

group('_parseFiles: нет файлов');
test('пустой список → null/null', () => {
  const r = _parseFiles([], new Map());
  assert.strictEqual(r.textPrompt, null);
  assert.strictEqual(r.imageFile, null);
});

group('_parseFiles: только текстовые файлы');
test('.txt файл с содержимым → textPrompt заполнен', () => {
  const files = [{ name: 'desc.txt', ext: '.txt' }];
  const contents = new Map([['desc.txt', 'Описание товара']]);
  const r = _parseFiles(files, contents);
  assert.strictEqual(r.textPrompt, 'Описание товара');
  assert.strictEqual(r.imageFile, null);
});
test('.txt файл пустой → textPrompt null', () => {
  const files = [{ name: 'empty.txt', ext: '.txt' }];
  const contents = new Map([['empty.txt', '   ']]);
  const r = _parseFiles(files, contents);
  assert.strictEqual(r.textPrompt, null);
});
test('текст обрезается до 500 символов', () => {
  const files = [{ name: 'long.txt', ext: '.txt' }];
  const contents = new Map([['long.txt', 'x'.repeat(600)]]);
  const r = _parseFiles(files, contents);
  assert.strictEqual(r.textPrompt.length, 500);
});

group('_parseFiles: только изображения');
test('одно изображение → imageFile заполнен', () => {
  const files = [{ name: 'photo.jpg', ext: '.jpg' }];
  const r = _parseFiles(files, new Map());
  assert.strictEqual(r.imageFile, 'photo.jpg');
  assert.strictEqual(r.textPrompt, null);
});
test('все расширения изображений распознаются', () => {
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
    const files = [{ name: `img${ext}`, ext }];
    const r = _parseFiles(files, new Map());
    assert.strictEqual(r.imageFile, `img${ext}`, `ext ${ext} not recognized`);
  }
});
test('несколько изображений → возвращается одно (случайное)', () => {
  const files = [
    { name: 'a.png', ext: '.png' },
    { name: 'b.jpg', ext: '.jpg' },
    { name: 'c.webp', ext: '.webp' },
  ];
  const results = new Set();
  for (let i = 0; i < 30; i++) {
    const r = _parseFiles(files, new Map());
    results.add(r.imageFile);
  }
  assert.ok(results.size > 1, 'должен быть случайный выбор из нескольких изображений');
});

group('_parseFiles: текст + изображение');
test('оба типа → textPrompt и imageFile заполнены', () => {
  const files = [
    { name: 'desc.txt', ext: '.txt' },
    { name: 'photo.jpg', ext: '.jpg' },
  ];
  const contents = new Map([['desc.txt', 'Описание']]);
  const r = _parseFiles(files, contents);
  assert.strictEqual(r.textPrompt, 'Описание');
  assert.strictEqual(r.imageFile, 'photo.jpg');
});

group('_parseFiles: нераспознанные файлы');
test('.pdf файл игнорируется в обоих полях', () => {
  const files = [{ name: 'doc.pdf', ext: '.pdf' }];
  const r = _parseFiles(files, new Map());
  assert.strictEqual(r.textPrompt, null);
  assert.strictEqual(r.imageFile, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (errors.length) { console.error(errors); process.exit(1); }
