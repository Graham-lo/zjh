/**
 * 通用人性底层（设计文档 §4.9 / §4.10）。
 *
 * 零领域依赖：这个包里的任何文件都不 import `shared/game.ts`、`shared/zjh/**`、
 * `server/**` 或任何牌类型 —— `tests/mind.test.ts` 有一条 import 图断言在守这条线。
 * 接一个新领域只需要写一个 `DomainAdapter`（见 `docs/mind/README.md`）。
 */

export * from './emotion.ts';
export * from './regularities.ts';
export * from './traits.ts';
export * from './adapter.ts';
export * from './dual.ts';
