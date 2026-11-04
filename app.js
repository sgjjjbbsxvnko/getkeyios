const $ = id => document.getElementById(id);
let currentKey = '';
const message = $('message');
const result = $('result');
function notice(text, error = false) {
  message.textContent = text;
  message.className = 'message ' + (text ? error ? 'error' : 'success' : '');
}
function setBusy(button, busy, caption) {
  button.disabled = busy;
  button.textContent = busy ? 'Đang xử lý...' : caption;
}
function switchTab(tab) {
  const redeem = tab === 'redeem';
  $('redeemPanel').hidden = !redeem;
  $('statusPanel').hidden = redeem;
  $('redeemTab').classList.toggle('active', redeem);
  $('statusTab').classList.toggle('active', !redeem);
  $('redeemTab').setAttribute('aria-selected', String(redeem));
  $('statusTab').setAttribute('aria-selected', String(!redeem));
  result.hidden = true;
  notice('');
}
$('redeemTab').addEventListener('click', () => switchTab('redeem'));
$('statusTab').addEventListener('click', () => switchTab('status'));
async function post(path, data) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(payload.error || 'INVALID_RESPONSE');
  return payload.data;
}
function showResult({key = '', status = 'active', expiresAt = null}, allowCopy = false) {
  result.hidden = false;
  currentKey = key;
  $('resultKey').textContent = key || 'Không có key';
  $('resultStatus').textContent = ({ active: 'ĐANG DÙNG', unactivated: 'CHƯA KÍCH HOẠT', expired: 'HẾT HẠN', revoked: 'ĐÃ THU HỒI' })[status] || status.toUpperCase();
  $('resultStatus').classList.toggle('bad', status === 'revoked' || status === 'expired');
  $('resultExpiry').textContent = expiresAt ? new Date(expiresAt).toLocaleString('vi-VN') : 'Chưa kích hoạt';
  $('copyButton').hidden = !allowCopy;
}
const messages = {
  INVALID_VOUCHER: 'Mã nhận key không đúng định dạng.',
  VOUCHER_UNAVAILABLE: 'Mã nhận key đã sử dụng, không tồn tại hoặc hết hạn.',
  INVALID_KEY_FORMAT: 'Key iOS không đúng định dạng.',
  LICENSE_UNAVAILABLE: 'Key không tồn tại hoặc chưa được cấp.',
  RATE_LIMITED: 'Bạn gửi quá nhiều yêu cầu. Hãy thử lại sau.',
  RATE_LIMIT_UNAVAILABLE: 'Dịch vụ tạm bận.',
  D1_NOT_CONFIGURED: 'Cơ sở dữ liệu chưa được cấu hình.',
  SERVICE_NOT_CONFIGURED: 'Máy chủ chưa cấu hình đầy đủ.',
  LINK4M_NOT_CONFIGURED: 'Chưa cấu hình Link4M trên máy chủ iOS.',
  LINK4M_API_FAILED: 'Link4M trả về lỗi khi tạo link (LINK4M_API_FAILED).',
  LINK4M_API_REJECTED: 'Link4M từ chối yêu cầu. Chủ tài khoản hãy kiểm tra API token và quyền sử dụng dịch vụ.',
  LINK4M_AUTH_FAILED: 'API token Link4M không hợp lệ hoặc tài khoản không có quyền (401/403).',
  LINK4M_RATE_LIMITED: 'Link4M đang giới hạn số lần tạo link. Hãy thử lại sau.',
  LINK4M_UPSTREAM_UNAVAILABLE: 'Máy chủ Link4M đang gặp lỗi (5xx).',
  LINK4M_TIMEOUT: 'Kết nối Link4M hết thời gian chờ.',
  LINK4M_NETWORK_ERROR: 'Worker không kết nối được tới API Link4M.',
  LINK4M_INVALID_RESPONSE: 'API Link4M không trả về JSON hợp lệ.',
  LINK4M_INVALID_SHORT_URL: 'API Link4M chưa trả về URL rút gọn hợp lệ.',
  LINK4M_RESPONSE_TOO_LARGE: 'Phản hồi Link4M vượt quá giới hạn an toàn.',
  LINK4M_UNTRUSTED_API_REDIRECT: 'Link4M yêu cầu chuyển tới máy chủ API không được tin cậy.',
  LINK4M_INVALID_API_REDIRECT: 'Link4M trả về chuyển hướng API không hợp lệ.',
  LINK4M_REDIRECT_LOOP: 'Link4M chuyển hướng API quá nhiều lần.',
  INVALID_RESPONSE: 'Máy chủ iOS trả về kết quả không hợp lệ.',
  INTERNAL_ERROR: 'Worker gặp lỗi nội bộ. Kiểm tra Cloudflare Worker Logs.',
  LINK4M_UNTRUSTED_SHORT_URL: 'Link4M trả về tên miền chưa được cho phép.',
  LINK_SESSION_EXPIRED: 'Phiên Link4M đã hết hạn. Hãy nhận key lại.',
  LINK4M_STEPS_REQUIRED: 'Chưa xác nhận đủ hai bước Link4M.'
};
function friendly(error) {
  const code = String(error?.message || 'NETWORK_ERROR').replace(/[^A-Z0-9_]/gi, '').slice(0,60);
  return messages[code] || `Không thể thực hiện (mã lỗi: ${code}). Vui lòng báo quản trị viên.`;
}
async function startLink4m() {
  const button = $('generateBtn');
  setBusy(button, true, '✦ Vượt Link4M nhận Key 24H');
  result.hidden = true;
  notice('Đang tạo đường dẫn Link4M...');
  try {
    const response = await fetch('/api/ios/link4m/start', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json.ok || typeof json.shortUrl !== 'string')
      throw new Error(json.error || 'INVALID_RESPONSE');
    // Short URL is validated by the server; never accept a URL from query params.
    window.location.assign(json.shortUrl);
  } catch (err) {
    notice(friendly(err), true);
    setBusy(button, false, '✦ Vượt Link4M nhận Key 24H');
  }
}
async function completeLink4m(sessionToken) {
  const button = $('generateBtn');
  setBusy(button, true, '✦ Vượt Link4M nhận Key 24H');
  notice('Đang xác nhận phiên Link4M và tạo key iOS...');
  result.hidden = true;
  try {
    const response = await fetch('/api/ios/link4m/complete', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionToken })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok || !payload.data) throw new Error(payload.error || 'INVALID_RESPONSE');
    const data = payload.data;
    showResult(data, true);
    $('checkKey').value = data.key;
    sessionStorage.setItem('sent_ios_last_key', data.key);
    // Remove the sensitive, single-use browser token from the address bar.
    window.history.replaceState({}, document.title, window.location.pathname);
    notice(payload.reused ? 'Đã khôi phục key iOS cho phiên này.' : 'Đã tạo key iOS 24H. Nhập key vào app iPhone để kích hoạt.');
  } catch (err) { notice(friendly(err), true); }
  finally { setBusy(button, false, '✦ Vượt Link4M nhận Key 24H'); }
}
$('generateBtn').addEventListener('click', startLink4m);
$('redeemForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('redeemButton');
  setBusy(button, true, '✦ Nhận Key iOS 24H');
  result.hidden = true;
  notice('');
  try {
    const data = await post('/api/ios/redeem', { voucher: $('voucher').value.trim().toUpperCase() });
    showResult(data, true);
    $('voucher').value = '';
    $('checkKey').value = data.key;
    // Session-only storage; the backend is authoritative for expiry and activation.
    sessionStorage.setItem('sent_ios_last_key', data.key);
    notice('Đã nhận key! Sao chép và nhập vào app iPhone để bắt đầu 24 giờ.');
  } catch (err) { notice(friendly(err), true); }
  finally { setBusy(button, false, '✦ Nhận Key iOS 24H'); }
});
$('statusForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('statusButton');
  setBusy(button, true, '⌕ Kiểm tra trạng thái key');
  result.hidden = true;
  notice('');
  try {
    const key = $('checkKey').value.trim().toUpperCase();
    const data = await post('/api/ios/status', { key });
    showResult({ key, ...data }, true);
    notice('Đã cập nhật trạng thái key từ máy chủ.');
  } catch (err) { notice(friendly(err), true); }
  finally { setBusy(button, false, '⌕ Kiểm tra trạng thái key'); }
});
$('copyButton').addEventListener('click', async () => {
  if (!currentKey) return;
  try { await navigator.clipboard.writeText(currentKey); notice('Đã sao chép key!'); }
  catch { notice('Không thể sao chép tự động. Hãy chọn và sao chép key thủ công.', true); }
});
const oldKey = sessionStorage.getItem('sent_ios_last_key');
if (oldKey && /^IOS-/.test(oldKey)) $('checkKey').value = oldKey;

// Callback step 2 returns to the home page with an opaque session token.
const incoming = new URLSearchParams(location.search);
const errCode = incoming.get('link4m_error');
if (errCode) {
  notice('Phiên Link4M chưa hoàn thành (' + errCode.replace(/[^a-z0-9_]/gi, '') + '). Hãy thử lại.', true);
  history.replaceState({}, document.title, location.pathname);
} else {
  const sessionToken = incoming.get('session');
  if (sessionToken) completeLink4m(sessionToken);
}
