import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCharacterCard, validateMonsterDef } from '../src/index.ts';

const validCard = {
  schemaVersion: 1,
  id: 'card_test',
  identity: { name: '阿青', race: '山民', class: '武者', level: 1 },
  abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 10 },
  proficiency: { bonus: 2, skills: ['athletics', 'intimidation'], saves: ['str', 'con'] },
  combat: {
    ac: 16,
    hpMax: 12,
    attacks: [{ name: '横刀', ability: 'str', proficient: true, damage: '1d8', range: 'engaged' }],
  },
  inventory: [{ name: '火折子', qty: 1 }],
  publicSummary: '背刀的山民少女',
};

test('validateCharacterCard: accepts a well-formed card', () => {
  const result = validateCharacterCard(validCard);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.value?.identity.name, '阿青');
});

test('validateCharacterCard: rejects wrong schema and missing identity', () => {
  assert.equal(validateCharacterCard({ ...validCard, schemaVersion: 2 }).ok, false);
  const { identity: _identity, ...noIdentity } = validCard;
  const result = validateCharacterCard(noIdentity);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('identity')));
});

test('validateCharacterCard: reports ability / attack / skill problems', () => {
  const bad = {
    ...validCard,
    abilities: { ...validCard.abilities, str: 99 },
    proficiency: { ...validCard.proficiency, skills: ['flying'] },
    combat: {
      ...validCard.combat,
      attacks: [{ name: '', ability: 'luck', proficient: true, damage: 'twenty', range: 'somewhere' }],
    },
  };
  const result = validateCharacterCard(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('abilities.str')));
  assert.ok(result.errors.some((error) => error.includes('skills')));
  assert.ok(result.errors.some((error) => error.includes('attacks[0].ability')));
  assert.ok(result.errors.some((error) => error.includes('attacks[0].damage')));
});

test('validateMonsterDef: accepts a valid monster and rejects broken stats', () => {
  const monster = {
    id: 'shanxiao',
    name: '山魈',
    cr: 1,
    ac: 13,
    hpMax: 12,
    abilities: { str: 12, dex: 12, con: 12, int: 6, wis: 10, cha: 8 },
    attacks: [{ name: '利爪', ability: 'str', proficient: true, damage: '1d6', range: 'engaged' }],
  };
  assert.equal(validateMonsterDef(monster).ok, true);
  assert.equal(validateMonsterDef({ ...monster, hpMax: 0 }).ok, false);
  assert.equal(validateMonsterDef({ ...monster, ac: -1 }).ok, false);
});
