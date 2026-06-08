/**
 * Channel plugin object (assembled).
 *
 * This file exports the actual `ChannelPlugin<XiaozhiAccount>` instance.
 * openclaw loads it lazily via `defineBundledChannelEntry`'s
 * `plugin.specifier + exportName` mechanism.
 */

import { createXiaozhiChannelPlugin } from "./channel.js";

export const xiaozhiPlugin = createXiaozhiChannelPlugin();
