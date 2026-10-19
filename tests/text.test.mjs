// Разбор HTML листов: «самозакрывающиеся» теги, как их понимает Roll20
import test from 'node:test';
import assert from 'node:assert/strict';
import { expandSelfClosing, closeOpenTextareas, normalizeSheetHtml } from '../shared/text.js';

test('непустые теги раскрываются, пустые — нет', () => {
  assert.equal(expandSelfClosing('<textarea name="attr_virtues" />'), '<textarea name="attr_virtues"></textarea>');
  assert.equal(expandSelfClosing('<span name="attr_x"/>'), '<span name="attr_x"></span>');
  assert.equal(expandSelfClosing('<div class="a" data-x=\'1/2\' />'), '<div class="a" data-x=\'1/2\'></div>');
  assert.equal(expandSelfClosing('<input type="text" name="attr_y"/>'), '<input type="text" name="attr_y"/>');
  assert.equal(expandSelfClosing('<br/><img src="a/b.png"/>'), '<br/><img src="a/b.png"/>');
  assert.equal(expandSelfClosing('<button type="roll" value="[[1d6]] /> x" />'), '<button type="roll" value="[[1d6]] /> x"></button>');
  assert.equal(expandSelfClosing('<span>a/b</span>'), '<span>a/b</span>');
});

test('незакрытый textarea закрывается перед следующим тегом', () => {
  assert.equal(closeOpenTextareas('<div><textarea name="a">\n</div><b>x</b>'), '<div><textarea name="a">\n</textarea></div><b>x</b>');
  assert.equal(closeOpenTextareas('<textarea name="b">текст</textarea><i>y</i>'), '<textarea name="b">текст</textarea><i>y</i>');
  assert.equal(closeOpenTextareas('<textarea name="c" placeholder="a>b">'), '<textarea name="c" placeholder="a>b"></textarea>');
  assert.equal(closeOpenTextareas('<textarea name="f">1 < 2</textarea>'), '<textarea name="f">1 < 2</textarea>');
  assert.equal(normalizeSheetHtml('<textarea name="d"/><textarea name="e">\n<div>z</div>'), '<textarea name="d"></textarea><textarea name="e">\n</textarea><div>z</div>');
});
