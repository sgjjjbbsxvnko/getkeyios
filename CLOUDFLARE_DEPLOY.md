# Sent Tweaks iOS — trạng thái kết nối

## Đã thực hiện
- Cloudflare account: `70bb58620c6ab34db2c46ed01f3e5c22`
- Worker riêng: `sent-ios-getkey`
- Subdomain Cloudflare: `quyenfa4-sentios`
- D1 riêng: `sent-ios-key-db` (`4f732554-4c1a-41b8-b8fc-d4634b66a6d7`)
- SQL `ios-schema.sql` đã chạy thành công.
- Worker website tĩnh + API đã được tải lên Cloudflare API.

## Chưa hoàn tất
1. GitHub kết nối qua ChatGPT từ chối ghi repository (403), nên cần sao chép thư mục `ios-site/` và file `wrangler-ios.jsonc` mới lên repo `sgjjjbbsxvnko/getkeyios`.
2. Cloudflare Worker chưa có `IOS_ADMIN_TOKEN`, `IOS_DEVICE_SALT`, `IOS_AUTH_PRIVATE_KEY_PEM`, `LINK4M_API_TOKEN`.
3. Link4M cần token từ chủ tài khoản đủ điều kiện; việc chạy callback không có bằng chứng xác minh hoàn tất từ Link4M.
4. Chưa kiểm thử Web thực tế hoặc Swift trên iPhone; cần hoàn thiện khóa ký và nhúng public key.

### Lệnh sau khi repository cập nhật và đã cấu hình secret
```
npm install
npm run deploy
```

Không đăng private key hoặc API token lên repository.
