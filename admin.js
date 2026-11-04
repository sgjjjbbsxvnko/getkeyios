const $ = id => document.getElementById(id);
let lastVoucher = '';
const errorLabels = { UNAUTHORIZED:'Admin token không đúng hoặc chưa cấu hình.', RATE_LIMITED:'Quá nhiều yêu cầu, vui lòng thử lại sau.', INVALID_KEY_FORMAT:'Định dạng key không hợp lệ.', NOT_FOUND:'Không tìm thấy key.', D1_NOT_CONFIGURED:'Chưa cấu hình cơ sở dữ liệu.' };
function notice(text, bad=false) {const el=$('adminMessage'); el.textContent=text;el.className='message '+(bad?'error':'success');}
async function api(path, body) {
  const token = $('adminToken').value.trim();
  if (!token) throw new Error('Hãy nhập IOS_ADMIN_TOKEN.');
  const response = await fetch(path, {method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${token}`},body:JSON.stringify(body)});
  const value = await response.json().catch(()=>({}));
  if (!response.ok || !value.ok) throw new Error(errorLabels[value.error] || value.error || 'Máy chủ từ chối yêu cầu.');
  return value;
}
$('showToken').addEventListener('click',()=>{$('adminToken').type=$('adminToken').type==='password'?'text':'password'});
$('clearToken').addEventListener('click',()=>{$('adminToken').value='';lastVoucher='';$('createdVoucher').hidden=true;$('copyVoucher').hidden=true;$('createdLabel').hidden=true;notice('Đã xóa thông tin phiên admin.');});
$('createVoucher').addEventListener('click',async()=>{
  const b=$('createVoucher');b.disabled=true;notice('Đang tạo mã...',false);
  try{const r=await api('/api/ios/admin/create-key',{planHours:24});lastVoucher=r.data.voucher;$('createdVoucher').textContent=lastVoucher;$('createdVoucher').hidden=false;$('createdLabel').hidden=false;$('copyVoucher').hidden=false;notice('Đã tạo mã nhận key một lần.');}
  catch(e){notice(e.message,true)}finally{b.disabled=false}
});
$('copyVoucher').addEventListener('click',async()=>{if(!lastVoucher)return;try{await navigator.clipboard.writeText(lastVoucher);notice('Đã sao chép mã.')}catch{notice('Sao chép thủ công trong ô mã.',true)}});
$('revokeButton').addEventListener('click',async()=>{
  const key=$('revokeKey').value.trim().toUpperCase();if(!/^IOS-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(key)){notice('Định dạng key không hợp lệ.',true);return;}
  if(!confirm('Xác nhận thu hồi key này?'))return;
  const b=$('revokeButton');b.disabled=true;
  try{await api('/api/ios/admin/revoke-key',{key});notice('Key đã bị thu hồi trên server.');}
  catch(e){notice(e.message,true)}finally{b.disabled=false}
});
