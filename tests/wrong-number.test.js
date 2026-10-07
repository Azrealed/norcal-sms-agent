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
