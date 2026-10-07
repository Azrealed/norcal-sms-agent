const test = require('node:test');
const assert = require('node:assert');
const { isWrongNumber } = require('../lib/policy');

test('ordinary "not ..." phrases are not wrong numbers', () => {
  for (const m of ['The house needs some TLC so not quite looking for a quick sale', 'not sure yet', 'not right now', 'I will not sell below 500k']) {
    assert.equal(isWrongNumber(m), false, m);
  }
});

test('real wrong-number replies are caught', () => {
  for (const m of ["I'm not Teresa.", 'I am not wendy. I am dave', 'Wrong number', 'This is not Mike']) {
    assert.equal(isWrongNumber(m), true, m);
  }
});

test('"wrong phone number" variants are caught; "no not really" is not', () => {
  for (const m of ['Wrong phone number.', 'wrong cell number', 'Wrong #', "Wrong person I'm not lisa", 'You have the wrong number']) {
    assert.equal(isWrongNumber(m), true, m);
  }
  for (const m of ['No not really, thank you!', 'No', 'Probably not.']) {
    assert.equal(isWrongNumber(m), false, m);
  }
});

test('"phone does not belong to" and "do not disturb" are wrong number / opt-out', () => {
  const { isOptOutMessage } = require('../lib/policy');
  const m = 'Derek, This phone does not belong to Mary.Please do not disturb me.';
  assert.equal(isWrongNumber(m), true);
  assert.equal(isOptOutMessage(m), true);
  assert.equal(isWrongNumber('No one here by that name'), true);
});
