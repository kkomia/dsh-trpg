/** 测试共享工具：深拷贝 fixtures，避免用例之间互相污染。 */
import { MINIMAL_RULE_PACK, SAMPLE_CARDS, type CardInstance, type RulePack } from '../src/index.ts';

export function clonePack(): RulePack {
  return structuredClone(MINIMAL_RULE_PACK);
}

export function withPack(mutate: (pack: RulePack) => void): RulePack {
  const pack = clonePack();
  mutate(pack);
  return pack;
}

export function cloneCard(index = 0): CardInstance {
  const card = SAMPLE_CARDS[index];
  if (card === undefined) throw new Error(`没有第 ${index} 张示例卡`);
  return structuredClone(card);
}
