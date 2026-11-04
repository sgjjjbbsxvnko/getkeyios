# Sent Tweaks iOS — Get Key + Link4M 2 bước + xác thực trong app iPhone

Dự án độc lập cho **Cloudflare Workers + D1**, không thay đổi repository Android `quyenfa557-coder/Get-key-M-i`. Giao diện lấy cảm hứng từ bản Android: nền sáng, thẻ xanh–tím, bảng thông tin, ô key, sao chép, hướng dẫn, Telegram/YouTube, thêm tab **Kiểm tra key** và trang admin.

## 1. Phân biệt web và ứng dụng iPhone

- Website `/` có nút **Vượt Link4M nhận key iOS 24H** (2 bước giống luồng Android cũ), voucher admin dự phòng và **kiểm tra trạng thái key** bằng `/api/ios/status`.
- Trang admin `/admin.html` dùng token admin riêng để **tạo voucher** và **thu hồi key**. Token không được lưu trong sessionStorage hoặc localStorage.
- Chính app iPhone phải gọi `/api/ios/claim` (lần đầu) và `/api/ios/verify` (các lần sau), đồng thời **kiểm tra chữ ký RSA** bằng public key nhúng trong app. Không dùng endpoint `/status` hoặc chỉ nhìn `valid:true` để mở khóa chức năng.
- Tất cả key iOS dùng tiền tố `IOS-`, hoàn toàn tách biệt `SENT-` của Android.

**Phân biệt rất quan trọng:** Bản này đã tích hợp API rút gọn Link4M và callback **hai bước** để mang lại quy trình tương tự website Android cũ. Tuy nhiên, Link4M API rút gọn đang dùng **không trả về bằng chứng có chữ ký** xác nhận người dùng hoàn thành các bước quảng cáo. Vì vậy mã nguồn chỉ xác nhận *callback URL đã được truy cập*, không thể bảo đảm hoàn thành CAPTCHA/quảng cáo thực sự. Không dùng chỉ số này làm bằng chứng tuyệt đối về traffic hợp lệ, doanh thu hay gian lận. Nếu nhà cung cấp hỗ trợ webhook/callback xác thực độc lập, cần tích hợp thêm trước khi coi là hoàn thành thật.

**Điều khoản nhà cung cấp:** Link4M quy định tài khoản nhà xuất bản phải đủ 18 tuổi. Chỉ chủ tài khoản đủ điều kiện của dịch vụ được cấu hình API token và vận hành tính năng này.

## 2. Chính sách key

- **1 key gắn đúng 1 mã cài đặt iOS** được app tạo và lưu trong Keychain. Worker lưu HMAC-SHA256 của ID, không ghi ID thô vào D1.
- **24 giờ chính xác** tính từ lần `/api/ios/claim` hợp lệ đầu tiên; đồng hồ server đặt `expires_at = now + 86.400.000 ms`.
- Đăng nhập lại cùng ID không gia hạn. ID khác sẽ bị từ chối. Claim đồng thời ở hai ID khác nhau chỉ một ID có thể được ghi nhận (lệnh UPDATE điều kiện nguyên tử trong SQLite D1).
- `/verify` chỉ kiểm tra, không kích hoạt key mới. Key bị revoke/hết hạn phải thất bại.
- Voucher admin có thời hạn **7 ngày để đổi**, nhưng khi đổi thành key thì đồng hồ 24 giờ chưa bắt đầu; lần kích hoạt đầu tiên mới bắt đầu tính.
- Với Link4M: phiên web hết hạn sau **20 phút**; sau callback hai bước và yêu cầu complete, Worker cấp đúng **một** key iOS chưa kích hoạt cho phiên đó. Gọi complete lặp lại trong thời gian hợp lệ chỉ trả về key cũ.

> **Giới hạn kỹ thuật:** ID Keychain không phải bằng chứng phần cứng. Một app bị sửa đổi có thể giả mạo ID. Để chứng minh chính xác yêu cầu đến từ phiên bản app hợp lệ và ràng buộc mạnh hơn với iPhone, cần thêm **Apple App Attest** (server cấp challenge, xác minh attestation và assertion). Dự án này **chưa tích hợp App Attest**. Không nên quảng cáo là chống giả mạo phần cứng tuyệt đối.

## 3. Cài đặt & triển khai website riêng

Cần Node.js và Wrangler, tài khoản Cloudflare:

```bash
npm install
npx wrangler login
npx wrangler d1 create sent-ios-key-db
```

Dán `database_id` của database **iOS mới** vào `wrangler-ios.jsonc`. Không dùng database Android.

```bash
npm run migrate
```

Tạo 4 secret tại Cloudflare, mỗi secret nhập giá trị của bạn (không hardcode vào GitHub):

```bash
npx wrangler secret put IOS_ADMIN_TOKEN --config wrangler-ios.jsonc
npx wrangler secret put IOS_DEVICE_SALT --config wrangler-ios.jsonc
npx wrangler secret put IOS_AUTH_PRIVATE_KEY_PEM --config wrangler-ios.jsonc
npx wrangler secret put LINK4M_API_TOKEN --config wrangler-ios.jsonc
```

`IOS_ADMIN_TOKEN` và `IOS_DEVICE_SALT` phải là **hai chuỗi ngẫu nhiên khác nhau, dài tối thiểu 32 ký tự**. `LINK4M_API_TOKEN` là API token của tài khoản Link4M hợp lệ, chỉ đưa vào Cloudflare Secret. Nếu Link4M trả về URL rút gọn thuộc domain khác `link4m.co` hoặc `link4m.com`, xác minh domain đó thực sự thuộc nhà cung cấp và khai báo biến môi trường Worker `LINK4M_ALLOWED_SHORT_HOSTS` (danh sách hostname, cách nhau bằng dấu phẩy). Không tắt kiểm tra domain. Tạo RSA private key `PKCS#8` và public key tương ứng:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out ios-private.pem
openssl pkey -in ios-private.pem -pubout -out ios-public.pem
openssl rsa -pubin -in ios-public.pem -RSAPublicKey_out -out ios-public-pkcs1.pem
```

Nhập **nội dung `ios-private.pem`** vào Cloudflare Secret `IOS_AUTH_PRIVATE_KEY_PEM`; file này không được commit hoặc cho vào bản phát hành. Public key `ios-public-pkcs1.pem` được nhúng trong project Xcode (xem bước 5).

Triển khai:

```bash
npm run deploy
```

Sau đó truy cập URL Worker hiển thị trên màn hình. Trang iOS ở `/`; trang admin ở `/admin.html`. Website Android sẽ không bị thay đổi vì deploy Worker iOS riêng.

## 4. Các endpoint

| Method | Đường dẫn | Chức năng |
|---|---|---|
| POST | `/api/ios/admin/create-key` | Tạo voucher một lần, cố định 24 giờ. Cần `Authorization: Bearer <IOS_ADMIN_TOKEN>` |
| POST | `/api/ios/admin/revoke-key` | Thu hồi key. Cần admin token |
| POST | `/api/ios/redeem` | Đổi voucher một lần thành key iOS chưa kích hoạt |
| POST | `/api/ios/link4m/start` | Tạo phiên 20 phút và lấy URL Link4M bước 1; body `{}` |
| GET | `/senttwgetkey` | Callback bước 1; tạo URL Link4M bước 2 |
| GET | `/senttwnhankey` | Callback bước 2; xác nhận proof của phiên và quay lại web |
| POST | `/api/ios/link4m/complete` | Cấp một key iOS chưa kích hoạt từ phiên callback hai bước |
| POST | `/api/ios/status` | Tra cứu trạng thái để hiển thị trên web; **không xác thực thiết bị** |
| POST | `/api/ios/claim` | Kích hoạt lần đầu, khóa ID iPhone và ký kết quả RSA-SHA256 |
| POST | `/api/ios/verify` | Kiểm tra lại key + ID + hạn + thu hồi, trả về chữ ký RSA-SHA256 |
| GET | `/api/ios/health` | Health check |

Ví dụ request từ app (JSON):

```json
{
  "key": "IOS-XXXXX-XXXXX-XXXXX",
  "deviceId": "879cbddd-517e-4cd7-9a34-9bcabf57bff7",
  "nonce": "0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

`nonce` phải sinh ngẫu nhiên cho **mỗi request**, 24 byte = 48 ký tự hex. Key 24 giờ và ID được kiểm tra bởi D1; phản hồi thành công gồm `auth.signature`, `auth.nonce`, `auth.deviceDigest`, `auth.serverTimeMs`, `data.expiresAtMs`.

## 5. Tích hợp trong ứng dụng iPhone — BẮT BUỘC

1. Mở project iOS **của chính bạn** trong Xcode (iOS 15+).
2. Thêm file `ios-client/SentIOSAuth.swift` vào target app.
3. Thêm **`ios-public-pkcs1.pem`** vào target app trong Xcode (không thêm private key).
4. Thay URL ví dụ trong Swift bằng hostname Worker iOS đã triển khai, `https://...workers.dev`.
5. Màn hình đăng nhập gọi `try await auth.claim(key: enteredKey)` khi kích hoạt lần đầu. Các lần mở chức năng cần bảo vệ gọi `try await auth.verify(key: enteredKey)`. Chỉ cho phép tiếp tục nếu hai hàm trả về thành công.
6. Không cache `valid:true` để dùng mãi. Bản SDK mẫu yêu cầu kết nối Internet để verify; server có thể revoke key ngay lập tức.
7. Định danh Keychain dùng `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`; không đồng bộ/migrate sang iPhone khác.

Bản Swift tự xây dựng chuỗi ký theo thứ tự trường cố định, kiểm tra `key`, `nonce`, SHA256 của device ID, `action`, `product=ios`, phiên bản giao thức, chữ ký RSA và thời gian. Nó không dựa vào `UserDefaults` để tin rằng key hợp lệ.

**Lưu ý tích hợp:** File Swift đã được kiểm tra cú pháp, nhưng chưa được compile trong Xcode trên iPhone thật vì môi trường tạo dự án không có Apple iOS SDK hoặc tài khoản ký app. Bạn cần build và thử trên iPhone sau khi deploy server.

## 6. Kiểm thử

```bash
npm test
python3 test-db.py
python3 test-link4m-db.py
```

Bộ test kiểm tra: chỉ 24h, voucher chỉ dùng một lần, claim đầu tiên mới bắt đầu đồng hồ, khóa một ID, không gia hạn, boundary 24h, RSA signature, revoke; đồng thời kiểm tra Link4M hai callback, từ chối complete quá sớm, proof bước hai, cấp key một lần và idempotency.

Các bài test Link4M sử dụng **mô phỏng API rút gọn**, không chứng minh dịch vụ Link4M thật đã nhận/công nhận một lượt vượt link. Sau deploy cần thử end-to-end với tài khoản Link4M đủ điều kiện. Thử thêm trên thiết bị thật: cùng key trên hai iPhone, app restart, đổi mạng, key hết hạn, key revoked.

## 7. Công việc chưa làm

- Chưa triển khai vào Cloudflare thật.
- Chưa kết nối với app iOS hiện tại vì chưa có source Xcode/project app.
- Chưa tích hợp App Attest.
- Link4M rút gọn + hai redirect callbacks **đã có**. Chưa có xác nhận hoàn thành bằng webhook có chữ ký hoặc API bằng chứng độc lập từ nhà cung cấp.
- Chưa kiểm thử trực tiếp với tài khoản/API Link4M production; không kết luận lượt truy cập được Link4M công nhận hợp lệ.

Tập tin `ios-schema.sql` chỉ dành cho D1 iOS mới. Không chạy migration này trong database Android.

## 8. Trình tự nhận key với Link4M

1. Người dùng bấm **Vượt Link4M nhận Key 24H** trên trang iOS.
2. Worker tạo phiên ngẫu nhiên 256-bit, lưu **hash** và thời hạn 20 phút trong D1; chỉ server giữ `LINK4M_API_TOKEN`.
3. Link4M redirect người dùng về `/senttwgetkey` (bước 1), Worker phát sinh proof ngẫu nhiên và tạo link rút gọn thứ hai.
4. Link4M redirect về `/senttwnhankey` (bước 2), Worker kiểm tra proof của phiên, đánh dấu phiên sẵn sàng.
5. Trang chủ tự gọi `/api/ios/link4m/complete`, Worker thực hiện cập nhật phiên + tạo key trong **một giao dịch D1**, rồi hiển thị key.
6. App iOS gọi `/api/ios/claim` để bắt đầu 24 giờ và khóa key theo một installation ID; `/verify` kiểm tra tiếp về sau.

**Mô hình tin cậy:** Callback URLs bước 1/2 có thể bị truy cập độc lập nếu một bên biết các URL đó. API rút gọn không cung cấp chứng thực hoàn thành, vì vậy đây là luồng UX hai bước *kiểu cũ*, **không phải xác minh hoàn tất Link4M chống gian lận**.

### Nâng cấp từ bản iOS trước (không mất key)

Chạy `npm run migrate` một lần trên **D1 iOS** của bạn; SQL chỉ tạo thêm bảng `ios_link_sessions` nếu chưa có. Đối với triển khai mới, chạy `npm run migrate` trước `npm run deploy`. Thêm `LINK4M_API_TOKEN` vào secrets iOS. Không chỉnh database hay Worker Android.

## Sửa lỗi Link4M — 2026-11-04

Bản sửa bổ sung xử lý redirect HTTPS với giới hạn máy chủ API được phép, giới hạn kích thước JSON, timeout, và các mã lỗi cho HTTP 401/403/429/5xx và kết nối bị ngắt. Giao diện hiển thị mã lỗi cụ thể thay cho lời nhắn chung. Có thể chạy `npm test` để kiểm tra cả lỗi Link4M mô phỏng.

Lưu ý: Đây không phải công cụ vượt xác minh nhà cung cấp. API token lộ trong ảnh hoặc tin nhắn phải được chủ tài khoản đủ điều kiện thay mới và lưu bằng Cloudflare Secret. Không đưa secret vào repository, và không mặc định rằng callback chứng minh một lượt hoàn tất hợp lệ.

Kết nối GitHub của buổi kiểm tra hiện trả 403 khi ghi vào repo, vì vậy bộ ZIP là bản cập nhật độc lập cho tới khi có quyền ghi.
