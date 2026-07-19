import type { Detail, Theme } from '../state.js';

function hints(tab: number, detail: Detail | undefined, zh: boolean): string {
  if (detail) return zh ? '滚轮/↑↓ 滚动   PgUp/PgDn 翻页   Esc 返回   q 退出' : 'wheel/↑↓ scroll   PgUp/PgDn page   Esc back   q quit';
  if (tab === 0) return zh ? '1–7/Tab 页面   滚轮/↑↓ 滚动   c 配置   按住 v 显示凭据   q 退出' : '1–7/Tab page   wheel/↑↓ scroll   c configure   hold v for credentials   q quit';
  if (tab === 1) return zh ? '滚轮/↑↓ 滚动   j/k 选择   Enter 打开   n 新建/委派   u 操作   q 退出' : 'wheel/↑↓ scroll   j/k select   Enter open   n new/delegate   u actions   q quit';
  if (tab === 2) return zh ? '滚轮/↑↓ 滚动   j/k 选择   Enter 完整对话   m 发送   q 退出' : 'wheel/↑↓ scroll   j/k select   Enter conversation   m send   q quit';
  if (tab === 3) return zh ? '滚轮/↑↓ 滚动   PgUp/PgDn 翻页   r 刷新   q 退出' : 'wheel/↑↓ scroll   PgUp/PgDn page   r refresh   q quit';
  if (tab === 4) return zh ? '滚轮/↑↓ 滚动   j/k 选择   e 新增   x 删除   q 退出' : 'wheel/↑↓ scroll   j/k select   e add   x remove   q quit';
  if (tab === 5) return zh ? '滚轮/↑↓ 滚动   c 修改配置   按住 v 显示凭据   k 轮换凭据   q 退出' : 'wheel/↑↓ scroll   c configure   hold v to reveal   k rotate   q quit';
  return zh ? '滚轮/↑↓ 滚动   a 事实调用 开/关   q 退出' : 'wheel/↑↓ scroll   a audit facts on/off   q quit';
}

export function Footer({ tab, detail, theme, zh, notice }: { tab: number; detail?: Detail; theme: Theme; zh: boolean; notice?: string }) {
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={theme.background}>
      {notice ? <box paddingLeft={1} paddingRight={1}><text fg={theme.good} wrapMode="word">{notice}</text></box> : null}
      <box backgroundColor={theme.panelAlt} paddingLeft={1} paddingRight={1}>
        <text fg={theme.text} wrapMode="word"><b>{hints(tab, detail, zh)}</b></text>
      </box>
    </box>
  );
}
