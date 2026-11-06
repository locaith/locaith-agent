import { describe, expect, it, vi } from 'vitest';
import { Presence, type PresenceSink } from '../../src/browser/presence';
import { SHOP, describeOf, readPage, rig } from './helpers/toolRig';

/** Người dùng đang xem `user`; trợ lý làm việc trên `work` (tab neo nằm nền). */
function twoTabs(r: ReturnType<typeof rig>) {
  const work = r.api.addTab({ url: SHOP, title: 'Cửa hàng' });
  const user = r.api.addTab({ url: 'https://mail.example.com/', title: 'Việc riêng của tôi' });
  r.api.activeId = user.id;
  r.scope.beginRun(work);
  return { work, user };
}

describe('không giành tab của người dùng', () => {
  it('thao tác (bấm/gõ) trên tab nền KHÔNG đưa tab đó lên trước — người dùng vẫn ở tab của mình', async () => {
    const r = rig('acceptEdits');
    const { work, user } = twoTabs(r);
    r.api.on('describe', describeOf());
    r.api.on('click', { ok: true, clicked: 'button', urlChanged: false, url: SHOP, title: 'x' });
    const res = await r.run('page_click', { ref: 7 });
    expect(res.isError).toBeFalsy();
    expect(r.api.calls.some((c) => c.method === 'click' && c.tabId === work.id)).toBe(true);
    expect(r.api.activeId).toBe(user.id);
  });

  it('bật "focusTabs": đưa tab lên trước như trước đây', async () => {
    const r = rig('acceptEdits', { focusTabs: true });
    const { work } = twoTabs(r);
    r.api.on('describe', describeOf());
    r.api.on('click', { ok: true, clicked: 'button', urlChanged: false, url: SHOP, title: 'x' });
    await r.run('page_click', { ref: 7 });
    expect(r.api.activeId).toBe(work.id);
  });

  it('tab_open: mở ở nền, đánh dấu là tab của trợ lý và thành tab làm việc; show=true hoặc focusTabs thì mở phía trước', async () => {
    const r = rig('acceptEdits');
    const { user } = twoTabs(r);
    r.decide.value = 'allow';
    const res = await r.run('tab_open', { url: 'https://news.example.com/' });
    expect(res.isError).toBeFalsy();
    const opened = r.api.tabs.at(-1)!;
    expect(r.api.activeId).toBe(user.id);
    expect(r.api.marked).toEqual([opened.id]);
    expect(r.scope.currentTabId).toBe(opened.id);
    expect(res.content).toContain('mở ở nền');

    const shown = await r.run('tab_open', { url: 'https://news.example.com/b', show: true });
    expect(shown.isError).toBeFalsy();
    expect(r.api.activeId).toBe(r.api.tabs.at(-1)!.id);
    expect(r.api.marked).toHaveLength(2);

    const r2 = rig('acceptEdits', { focusTabs: true });
    twoTabs(r2);
    await r2.run('tab_open', { url: 'https://news.example.com/' });
    expect(r2.api.activeId).toBe(r2.api.tabs.at(-1)!.id);
  });

  it('tab_activate: chỉ chọn làm tab làm việc, không chuyển màn hình; show=true mới đưa lên trước', async () => {
    const r = rig('acceptEdits');
    const { work, user } = twoTabs(r);
    const other = r.api.addTab({ url: 'https://docs.example.com/', title: 'Tài liệu' });
    r.decide.value = 'allow';
    const res = await r.run('tab_activate', { tab_id: other.id });
    expect(res.isError).toBeFalsy();
    expect(r.scope.currentTabId).toBe(other.id);
    expect(r.api.activeId).toBe(user.id);
    expect(res.content).toContain('không chuyển màn hình');

    const shown = await r.run('tab_activate', { tab_id: work.id, show: true });
    expect(shown.isError).toBeFalsy();
    expect(r.api.activeId).toBe(work.id);
    expect(r.scope.currentTabId).toBe(work.id);

    const gone = await r.run('tab_activate', { tab_id: 987654 });
    expect(gone.isError).toBe(true);
  });

  it('liên kết mở tab mới: tab mở thêm được đánh dấu; nếu trình duyệt tự đưa nó lên trước thì trả người dùng về trang họ đang xem', async () => {
    const r = rig('acceptEdits');
    const { work, user } = twoTabs(r);
    r.api.on('describe', describeOf({ role: 'link', tag: 'a', name: 'Mở', href: 'https://shop.vn/popup', target: '_blank' }));
    r.api.on('click', () => {
      const popup = r.api.addTab({ url: 'https://shop.vn/popup', title: 'Popup', openerTabId: work.id });
      r.api.activeId = popup.id; // trình duyệt tự chuyển sang tab vừa mở
      return { ok: true, value: { ok: true, clicked: 'link', urlChanged: false, url: SHOP, title: 'x' } };
    });
    const res = await r.run('page_click', { ref: 7 });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('Tab mới');
    expect(r.api.marked).toHaveLength(1);
    expect(r.api.activeId).toBe(user.id);
  });

  it('tab nguồn nằm nền: trình duyệt ghi tab ĐANG HIỆN làm opener — tab mới của đúng liên kết vẫn được nhận (không mở trùng), tab lạ của người dùng thì không', async () => {
    const r = rig('acceptEdits');
    const { user } = twoTabs(r);
    r.api.on('describe', describeOf({ role: 'link', tag: 'a', name: 'Mở', href: 'https://shop.vn/popup', target: '_blank' }));
    r.api.on('click', () => {
      const popup = r.api.addTab({ url: 'https://shop.vn/popup', title: 'Popup', openerTabId: user.id }); // opener = tab đang hiện
      r.api.addTab({ url: 'https://khac.example.org/x', title: 'Người dùng tự mở', openerTabId: user.id });
      r.api.activeId = popup.id;
      return { ok: true, value: { ok: true, clicked: 'link', urlChanged: false, url: SHOP, title: 'x' } };
    });
    const res = await r.run('page_click', { ref: 7 });
    expect(res.isError).toBeFalsy();
    expect(r.api.created).toEqual([]); // không mở thêm một tab trùng
    expect(r.scope.owned.size).toBe(1);
    expect(r.api.marked).toHaveLength(1);
    expect(r.api.tabs.find((t) => t.id === r.api.marked[0])?.url).toBe('https://shop.vn/popup');
    expect(r.api.activeId).toBe(user.id);
  });

  it('người dùng đã tự chuyển sang tab khác sau khi tab mới mở: không kéo họ đi đâu cả', async () => {
    const r = rig('acceptEdits');
    const { work } = twoTabs(r);
    const third = r.api.addTab({ url: 'https://khac.example.org/', title: 'Tab thứ ba' });
    r.api.on('describe', describeOf({ role: 'link', tag: 'a', name: 'Mở', href: 'https://shop.vn/popup', target: '_blank' }));
    r.api.on('click', () => {
      r.api.addTab({ url: 'https://shop.vn/popup', title: 'Popup', openerTabId: work.id });
      r.api.activeId = third.id; // người dùng tự bấm sang tab thứ ba
      return { ok: true, value: { ok: true, clicked: 'link', urlChanged: false, url: SHOP, title: 'x' } };
    });
    await r.run('page_click', { ref: 7 });
    expect(r.api.activeId).toBe(third.id);
  });

  it('liên kết target=_blank bị chặn cửa sổ bật lên: tự mở ở nền và đánh dấu', async () => {
    const r = rig('acceptEdits');
    const { user } = twoTabs(r);
    r.api.on('describe', describeOf({ role: 'link', tag: 'a', name: 'Trang mới', href: 'https://shop.vn/trang-moi', target: '_blank' }));
    r.api.on('click', { ok: true, clicked: 'link', urlChanged: false, url: SHOP, title: 'x' });
    await r.run('page_click', { ref: 7 });
    expect(r.api.created).toEqual(['https://shop.vn/trang-moi']);
    expect(r.api.activeId).toBe(user.id);
    expect(r.api.marked).toHaveLength(1);
  });
});

describe('viền sáng + nút Dừng: công cụ báo tab đang làm việc', () => {
  const spy = () => {
    const touch = vi.fn<PresenceSink['touch']>();
    let n = 0;
    const action: PresenceSink['action'] = (_tab, kind, what) => ({ n: ++n, kind, verb: 'Bấm', what });
    return { sink: { touch, action } satisfies PresenceSink, touch };
  };

  it('công cụ đọc báo "read", công cụ thao tác báo "act" — đúng tab đích', async () => {
    const { sink, touch } = spy();
    const r = rig('acceptEdits', { presence: sink });
    const { work } = twoTabs(r);
    r.api.on('read', readPage());
    r.api.on('snapshot', { ok: true, url: SHOP, title: 'x', text: '[7] button «Đặt hàng»', shown: 1, total: 1 });
    r.api.on('describe', describeOf());
    r.api.on('click', { ok: true, clicked: 'button', urlChanged: false, url: SHOP, title: 'x' });
    await r.run('page_read', {});
    await r.run('page_snapshot', {});
    await r.run('page_click', { ref: 7 });
    expect(touch.mock.calls).toEqual([
      [work.id, 'read'],
      [work.id, 'read'],
      [work.id, 'act'],
    ]);
  });

  it('chỉ báo khi công cụ THẬT SỰ chạy: bị từ chối xin phép hoặc không qua kiểm tra thì không hiện gì', async () => {
    const { sink, touch } = spy();
    const r = rig('default', { presence: sink });
    twoTabs(r);
    r.api.on('describe', describeOf());
    r.decide.value = 'deny';
    const denied = await r.run('page_click', { ref: 7 });
    expect(denied.isError).toBe(true);
    const invalid = await r.run('page_read', { tab_id: 424242 });
    expect(invalid.isError).toBe(true);
    expect(touch).not.toHaveBeenCalled();
  });

  it('đọc tab khác (tab_id): báo đúng tab đó', async () => {
    const { sink, touch } = spy();
    const r = rig('acceptEdits', { presence: sink });
    twoTabs(r);
    const other = r.api.addTab({ url: 'https://docs.example.com/', title: 'Tài liệu' });
    r.api.on('read', readPage('https://docs.example.com/'));
    r.decide.value = 'allow';
    await r.run('page_read', { tab_id: other.id });
    expect(touch).toHaveBeenCalledWith(other.id, 'read');
  });

  it('tab_open báo tab mới sau khi mở', async () => {
    const { sink, touch } = spy();
    const r = rig('acceptEdits', { presence: sink });
    twoTabs(r);
    r.decide.value = 'allow';
    await r.run('tab_open', { url: 'https://news.example.com/' });
    expect(touch).toHaveBeenCalledWith(r.api.tabs.at(-1)!.id, 'act');
  });

  it('chụp màn hình tab đang hiện: báo "read" sau khi chụp xong', async () => {
    const { sink, touch } = spy();
    const r = rig('acceptEdits', { presence: sink });
    const { work, user } = twoTabs(r);
    r.api.activeId = work.id; // người dùng đang xem chính tab làm việc
    const shot = await r.run('page_screenshot', {});
    expect(shot.images).toHaveLength(1);
    expect(touch).toHaveBeenCalledWith(work.id, 'read');
    expect(r.api.flips).toEqual([]);
    void user;
  });

  it('chụp màn hình tab NỀN: mặc định bị từ chối (không chuyển tab của người dùng), kèm hướng dẫn; không hiện viền sáng', async () => {
    const { sink, touch } = spy();
    const r = rig('acceptEdits', { presence: sink });
    const { user } = twoTabs(r);
    const shot = await r.run('page_screenshot', {});
    expect(shot.isError).toBe(true);
    expect(shot.content).toContain('đang nằm nền');
    expect(shot.content).toContain('page_snapshot');
    expect(shot.images).toBeUndefined();
    expect(r.api.captures).toEqual([]);
    expect(r.api.flips).toEqual([]);
    expect(r.api.activeId).toBe(user.id);
    expect(touch).not.toHaveBeenCalled();
  });

  it('bật "focusTabs": chụp tab nền được phép đưa tab lên trước MỘT LÚC (người dùng được trả về tab cũ)', async () => {
    const r = rig('acceptEdits', { focusTabs: true });
    const { work, user } = twoTabs(r);
    const shot = await r.run('page_screenshot', {});
    expect(shot.images).toHaveLength(1);
    expect(r.api.flips).toEqual([work.id]);
    expect(r.api.activeId).toBe(user.id);
  });
});

describe('con trỏ ảo + số bước cho thao tác lên phần tử', () => {
  const okClick = { ok: true, clicked: 'button', urlChanged: false, url: SHOP, title: 'x' };
  const fxOf = (r: ReturnType<typeof rig>, method: string) => (r.api.calls.find((c) => c.method === method)!.arg as { fx: Record<string, any> }).fx;

  it('bấm: runtime nhận fx (số bước, động từ, thứ được bấm, dữ liệu dựng lớp phủ); kết quả ghi rõ "Bước N" + địa chỉ nơi bấm; số bước đặt lại / nối tiếp được', async () => {
    const r = rig('acceptEdits', { presence: 'real' });
    const tab = r.api.addTab({ url: SHOP, title: 'Cửa hàng' });
    r.scope.beginRun(tab);
    r.api.on('describe', describeOf());
    r.api.on('click', okClick);
    const res = await r.run('page_click', { ref: 7 });
    expect(res.isError).toBeFalsy();
    const fx = fxOf(r, 'click');
    expect(fx).toMatchObject({ n: 1, kind: 'click', verb: 'Bấm', what: 'nút “Đặt hàng”' });
    expect(fx.show).toMatchObject({ on: true, label: 'Locaith AI đang điều khiển trang này', stopLabel: 'Dừng' });
    expect(res.content).toMatch(/^Bước 1 · Đã bấm nút “Đặt hàng” — tại https:\/\/shop\.vn\/trang\./);
    expect((await r.run('page_click', { ref: 7 })).content).toMatch(/^Bước 2 · /);
    r.presence!.resetSteps();
    expect((await r.run('page_click', { ref: 7 })).content).toMatch(/^Bước 1 · /);
    r.presence!.resetSteps(7); // mở lại cuộc trò chuyện cũ đã có tới bước 6
    expect((await r.run('page_click', { ref: 7 })).content).toMatch(/^Bước 7 · /);
  });

  it('chọn / rê chuột cũng có con trỏ; thao tác thất bại vẫn mang số bước trong sự kiện công cụ (để khung chat khớp với dấu trên trang)', async () => {
    const r = rig('acceptEdits', { presence: 'real' });
    const tab = r.api.addTab({ url: SHOP, title: 'Cửa hàng' });
    r.scope.beginRun(tab);
    r.api.on('describe', describeOf({ role: 'combobox', tag: 'select', name: 'Tỉnh/Thành phố' }));
    r.api.on('selectOption', { ok: true, selected: 'Hà Nội', value: 'HN' });
    r.api.on('hover', { ok: true, hovered: 'button' });
    r.api.on('click', { ok: false, code: 'blocked', message: 'bị che' });
    await r.run('page_select', { ref: 7, label: 'Hà Nội' });
    await r.run('page_hover', { ref: 7 });
    await r.run('page_click', { ref: 7 });
    expect(fxOf(r, 'selectOption')).toMatchObject({ n: 1, kind: 'select', what: 'ô chọn “Tỉnh/Thành phố”' });
    expect(fxOf(r, 'hover')).toMatchObject({ n: 2, kind: 'hover' });
    expect(fxOf(r, 'hover').what).toBeUndefined(); // runtime tự mô tả phần tử
    const ends = r.events.filter((e): e is Extract<typeof e, { t: 'tool_end' }> => e.t === 'tool_end');
    expect(ends.map((e) => e.step)).toEqual([1, 2, 3]);
    expect(ends[2].state).toBe('error'); // bị che, nhưng vẫn có số bước
  });

  it('không có Presence: nội dung giữ nguyên, không fx; người dùng tắt hiệu ứng: vẫn có số bước nhưng fx không mang dữ liệu dựng lớp phủ', async () => {
    const plain = rig('acceptEdits');
    const t1 = plain.api.addTab({ url: SHOP });
    plain.scope.beginRun(t1);
    plain.api.on('describe', describeOf());
    plain.api.on('click', okClick);
    const a = await plain.run('page_click', { ref: 7 });
    expect(a.content).toMatch(/^Đã bấm nút “Đặt hàng”\./);
    expect((plain.api.calls.find((c) => c.method === 'click')!.arg as Record<string, unknown>).fx).toBeUndefined();

    const r = rig('acceptEdits', { presence: 'real-off' });
    const t2 = r.api.addTab({ url: SHOP });
    r.scope.beginRun(t2);
    r.api.on('describe', describeOf());
    r.api.on('click', okClick);
    const b = await r.run('page_click', { ref: 7 });
    expect(b.content).toMatch(/^Bước 1 · /); // số bước vẫn có để nhắc lại
    expect(fxOf(r, 'click').show).toBeUndefined(); // không vẽ gì trên trang
  });

  it('canh tab mới tự nhảy lên trước: có khi thao tác (openers gồm tab nguồn và tab đang xem), không khi bật focusTabs', async () => {
    const r = rig('acceptEdits');
    const { work, user } = twoTabs(r);
    r.api.on('describe', describeOf());
    r.api.on('click', okClick);
    await r.run('page_click', { ref: 7 });
    expect(r.api.guards).toHaveLength(1);
    expect(r.api.guards[0]).toMatchObject({ backTo: user.id, openers: [work.id, user.id] });

    // người dùng đang xem chính tab làm việc: opener chỉ có tab đó
    const r2 = rig('acceptEdits');
    const w2 = r2.api.addTab({ url: SHOP });
    r2.scope.beginRun(w2);
    r2.api.on('describe', describeOf());
    r2.api.on('click', okClick);
    await r2.run('page_click', { ref: 7 });
    expect(r2.api.guards[0]).toMatchObject({ backTo: w2.id, openers: [w2.id] });

    const r3 = rig('acceptEdits', { focusTabs: true });
    const w3 = r3.api.addTab({ url: SHOP });
    r3.api.addTab({ url: 'https://khac.example.org/' });
    r3.scope.beginRun(w3);
    r3.api.on('describe', describeOf());
    r3.api.on('click', okClick);
    await r3.run('page_click', { ref: 7 });
    expect(r3.api.guards).toHaveLength(0);
  });
});
