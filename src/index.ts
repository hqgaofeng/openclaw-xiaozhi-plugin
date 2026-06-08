/**
 * openclaw-xiaozhi-plugin entry point
 *
 * Exports `createXiaozhiChannelPlugin()` which assembles the
 * ChannelPlugin<XiaozhiAccount> with all 17 fields.
 *
 * @see docs/sdk-research-v3.md §3 for field-by-field design.
 */

export { createXiaozhiChannelPlugin } from "./channel.js";
export type { XiaozhiAccount, XiaozhiConfig } from "./config.js";
