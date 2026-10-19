# Backend — Node.js + Express + MongoDB

`src/app.js` nối các nhóm API; handler nằm trong `src/routes/`, middleware dùng chung trong
`src/middleware/`. Xem [hướng dẫn tìm file cần sửa](../HUONG_DAN_SUA_CODE.md).

API cho hệ thống **nội bộ** của tiệm photobooth: lễ tân cấp mã tại quầy, máy chụp trong phòng
(kiosk), khách quét QR trên máy chụp để nhận ảnh trên điện thoại, lễ tân in ảnh 10 × 15 cm.
Không có trang công khai (không đặt lịch, không tra cứu mã vé trên web).

Album khách có thể chọn mọi ảnh gốc còn hạn làm ảnh yêu thích để lọc ảnh trước khi chọn khung,
không giới hạn theo số ô hay catalog khung. Khung đơn nhận tối đa 40 ô, gồm khung 13/14 ô.
Việc lưu lựa chọn chỉ nhận ảnh còn hạn thuộc đúng album và cập nhật
nguyên tử để giữ nguyên các ảnh vừa tải lên đồng thời. Logic ở `src/services/album-favorites.js`.

```bash
cd Photo_BE
npm ci
# Nếu chưa có .env: sao chép .env.example thành .env và điền cấu hình
npm run seed
npm run dev
```

API: http://localhost:8080/api/health. Tài khoản quản trị đầu tiên lấy từ `ADMIN_EMAIL` và `ADMIN_PASSWORD`.
`CLIENT_URL` là origin frontend được cho phép, mặc định http://localhost:5173.

```bash
npm start
npm test
```

## Thử API bằng Swagger

Mở **`/api/docs`** trên máy chủ (vd. http://localhost:8080/api/docs, hoặc `https://<máy chủ Render>/api/docs`).
Tài liệu gốc (OpenAPI 3) ở `/api/openapi.json`, viết trong `src/openapi.js`.

1. Nhóm **Đăng nhập → POST /api/auth/login** → _Try it out_ → nhập email / mật khẩu → _Execute_. Trình duyệt lưu
   cookie phiên, các API có ổ khóa sau đó tự gửi kèm (nút _Authorize_ không cần dùng).
2. Mở API muốn thử → _Try it out_ → sửa dữ liệu mẫu → _Execute_.

Trang Swagger chạy cùng địa chỉ với máy chủ nên được phép gửi lệnh ghi (POST/PUT/DELETE) dù không nằm trong
`CLIENT_URL`. Đây là dữ liệu thật của tiệm: vé thử tính vào doanh thu — hủy vé thử sau khi xong. Đặt `API_DOCS=false`
để tắt trang này. Test `swagger documents every API route…` báo lỗi nếu thêm API mới mà quên ghi vào `src/openapi.js`.

## Luật vận hành chính

- Mã vé 6 số dùng ở **mọi phòng**, bất kỳ giờ nào **trong ngày** cấp mã.
- `captureDuration` được chốt theo gói lúc cấp vé. Sửa thời gian gói chỉ áp dụng cho vé mới;
  vé cũ chưa có trường này lấy thời gian gói hiện tại khi bắt đầu chụp.
- Máy chụp báo trạng thái 2 giây/lần. Máy mất tín hiệu quá 20 giây thì phòng khác nhập lại mã
  để chụp tiếp phần thời gian còn lại; máy đang chạy thì mã không mở được ở phòng khác.
- Hết giờ mà máy chụp chưa bấm "Hoàn thành" (tắt máy, mất mạng…): máy chủ tự chốt phiên sau 2 phút.
- Số tờ in 10 × 15 cm theo gói (`prints`) + tờ lễ tân bán thêm; lệnh in chưa in bị hủy thì trả lại tờ.
- Gửi in lưu dấu kiểm tra ảnh, thứ tự và tên bộ. Cùng `requestKey` với nội dung khác trả 409;
  thử lại đúng nội dung trả lệnh cũ. `GET /api/albums/:token/print?requestKey=...` khôi phục đúng
  yêu cầu đã gửi và quota, chỉ trong album đó. Job cũ chưa có fingerprint vẫn được thử lại.
- `POST /api/admin/frames/:id/move` đổi thứ tự trong bộ theo `direction: up/down` và `expectedIds`.
  Kiểm tra danh sách cũ và chuẩn hóa thứ tự trùng/0; không thay ảnh, tên hoặc trạng thái khung.
- Ảnh mới lưu trong GridFS hoặc Cloudflare R2 theo `MEDIA_STORAGE_PROVIDER`; mặc định GridFS.
  [Hướng dẫn bật R2](R2_SETUP.md) gồm tạo bucket riêng tư, khóa và biến môi trường backend.
  Ảnh GridFS cũ vẫn mở được khi bật R2. **Mỗi ảnh tự xóa sau `MEDIA_TTL_HOURS` giờ (mặc định 24) kể từ lúc chụp / tải
  lên** — riêng từng ảnh, ảnh cũ đi trước; album hết ảnh thì báo hết hạn. `mediaExpiresAt` của vé = lúc ảnh sớm nhất
  còn lại tự xóa; API trả `expiresAt` cho từng ảnh. **Mỗi lệnh in giữ 24 giờ kể từ lúc khách gửi** (đã in hay chưa),
  rồi xóa cùng file tờ in; hàng chờ in chỉ hiện lệnh còn hạn, kèm `expiresAt`. Việc dọn chạy 15 phút/lần. Thông tin vé
  (mã, khách, tiền, số tờ in) giữ lại để xem doanh thu.
- Chỉ quản trị viên xem tiền: doanh thu, báo cáo theo tháng, tổng tiền từng vé (máy chủ không gửi các số này cho
  lễ tân). Lễ tân chỉ thấy số tiền cần thu khi tạo mã / bán thêm tờ in.
- Lễ tân vào **Phòng & chi nhánh** để xem phòng đang hoạt động và mở/cài kiosk: `GET /api/admin/rooms`
  và `POST /api/admin/rooms/:id/device` cần đăng nhập, cho phép `staff` và `admin`. Quản trị thấy cả phòng đã tắt;
  phòng đã tắt không được cấp mã máy chụp. Tạo/sửa/tắt phòng, cài đặt studio và các danh mục khác vẫn chỉ quản trị.
- Khách **chỉ chụp bằng nút chụp / remote của máy ảnh** (không có nút chụp trên màn hình): FUJIFILM X Acquire
  trên máy chụp lưu ảnh gốc vào thư mục, máy chụp (Chrome / Edge, Windows hoặc macOS) đọc thư mục rồi gửi lên
  `POST /api/kiosk/photo`. Mọi phiên mới có `captureMode: "folder"`.

Luồng nhận ảnh dùng chung GridFSBucket theo kết nối database để tránh kiểm tra
chỉ mục lại mỗi lần tải lên. JPEG gốc, thumbnail 640 px/JPEG 78 cho thư viện và preview
1600 px/JPEG 90 cho trình chỉnh ảnh được lưu đồng thời; chỉ cập nhật vé khi cả ba đã lưu xong,
và chờ mọi tác vụ kết thúc trước khi dọn nếu có lỗi. **Ảnh máy ảnh chỉ được giải mã một lần**
(giải mã JPEG 14 MB tốn ngang cả phần còn lại, mà gói free chỉ có ~0,1 CPU): các bản phụ cắt từ
cùng một bộ điểm ảnh đã xoay/lật, không qua JPEG trung gian. Sau khi ảnh đã lưu và vé đã cập nhật,
**nguồn in 3000 px/JPEG 95 / 4:4:4** (`printSource` trong album; ảnh chưa có thì in từ ảnh gốc) mới được
mã hóa ở nền (`src/services/print-source.js`): từng ảnh một, chỉ khi không có ảnh nào đang lưu, giữ
điểm ảnh đã giải mã cho tối đa 4 ảnh chờ (ảnh chờ nhiều hơn chỉ giữ tên file, giải mã lại từ ảnh gốc
đã lưu; tác vụ đọc lại không giữ tham chiếu tới bộ nhớ pixel cũ). Kiểm tra hàng chờ 9 ảnh xác nhận
các buffer thừa được thu hồi và cả 9 nguồn in vẫn hoàn tất. Ảnh bị
xóa/hết hạn giữa chừng thì tệp vừa tạo bị xóa, lỗi ở nền không ảnh hưởng ảnh đã lưu. Đo trên ảnh 16 MB:
CPU mỗi ảnh từ ~590 ms xuống ~310 ms trước khi báo "đã lưu" (~410 ms tính cả nguồn in).
**Máy chụp gửi kèm ảnh xem trước 1600 px** nó vốn đã làm để hiện màn hình (nối sau ảnh gốc trong cùng
yêu cầu, header `X-Photo-Preview-Length`): máy chủ kiểm tra (JPEG, đúng chiều, đúng khung hình ±2 %,
cạnh dài 640–2048 px) rồi dùng làm preview và làm thumbnail từ nó, không phải giải mã ảnh gốc trước
khi báo "đã lưu" — CPU mỗi ảnh còn ~31–47 ms thay vì ~327 ms (ảnh 16 MB). Ảnh gốc vẫn lưu nguyên byte;
nguồn in vẫn làm từ ảnh gốc ở nền. Ảnh xem trước không hợp lệ thì máy chủ tự làm như cũ. Số luồng sharp
theo CPU thật được cấp (`SHARP_CONCURRENCY` để ghi đè); mỗi lần lưu ảnh trả header `Server-Timing: save;dur=…`
(tab Network của trình duyệt) để biết ảnh lưu mất bao lâu. JPEG sạch được lưu **nguyên byte**;
JPEG có metadata được bỏ thông tin riêng tư, giữ nguyên dữ liệu pixel, ICC và thẻ EXIF
orientation tối thiểu. PNG/WebP/CMYK được chuyển một lần sang JPEG 100 / 4:4:4.
Tệp cụt/hỏng bị từ chối (400). Xem/chỉnh vị trí dùng bản nhẹ; tải ảnh về luôn là ảnh gốc.
Tạo tờ in đọc nguồn in 3000 px (ô khung trên tờ 1200 × 1800 chỉ cần dưới ~900 px nên bản in
không khác), chỉ đọc ảnh gốc khi một ô phóng to vượt số điểm ảnh của nguồn in — không bao giờ
phóng ảnh lên. Ảnh cũ chưa có nguồn in vẫn in từ ảnh gốc. Tờ in (PNG, không nén mất) được gửi
**dạng nhị phân** (`application/octet-stream`, header `X-Print-Sheets`/`X-Print-Key`/`X-Print-Frame`)
nhỏ hơn base64 JSON khoảng 1/4; máy chủ kiểm tra tờ này trong lúc tờ trước đang lưu lên R2. Dấu vân
tay chống in trùng tính giống hệt cho cả hai cách gửi, nên gửi lại một yêu cầu cũ (JSON) vẫn nhận
đúng lệnh in cũ. Preview/nguồn in được đo dung lượng
và dọn cùng ảnh gốc khi hết hạn. Liên kết R2 trực tiếp (`?direct=1`) được ký theo từng khung
2 phút nên giống hệt nhau trong khung đó: trình duyệt dùng lại ảnh và chuyển hướng đã lưu
(`Cache-Control: private, max-age` tới trước khi liên kết hết hạn, tối đa 5 phút, không quá hạn ảnh).
Phản hồi album kèm luôn link thumbnail/preview/nguồn in/ảnh gốc của từng ảnh (`photos[].links`, đúng các
URL trên trong cùng khung 2 phút): thư viện mở 60 ảnh tải thẳng từ R2, không cần 60 lượt hỏi Render; trình
chỉnh và bước ghép tờ in cũng không phải hỏi Render cho từng ô. Phản hồi album là `private, no-cache` có
ETag: trong cùng khung, lần web hỏi lại chỉ nhận 304 rỗng. Link được ký bằng
HMAC (`src/services/r2-presign.js`, ~0,05 ms/link, khớp từng byte với AWS SDK — test so sánh) và nhớ
theo khung, nên mỗi lần web hỏi lại album gần như không tốn CPU. Link hết hạn thì web dùng lại `?direct=1`.
Ghi R2 thất bại không tự chuyển sang GridFS. Thiếu cấu hình R2 khi chọn provider=r2 thì không khởi động.
**Ảnh gốc máy chụp và ảnh JPEG khách thêm từ điện thoại đi thẳng lên R2** (không qua Render) khi bucket
cho phép PUT — xem R2_SETUP.md mục 7. Đo thật ngày 17/10/2026 (ảnh 26 MP 14,7 MB, album thử đã xóa): qua
Render mất ~27–29 giây tới khi "đã lưu" (riêng đẩy 15 MB qua proxy web tới Render ~23 giây), thẳng R2 ~5 giây
(xin URL 0,4 s + tải lên R2 2,3 s + xác nhận 2,5 s);
backend chỉ nhận ảnh xem trước nhỏ và đọc 128 KB đầu của ảnh gốc để kiểm tra.
"Tải tất cả ảnh gốc" là ZIP không nén, ghi dần từng ảnh: mã kiểm tra CRC-32 dùng hàm có sẵn của
Node (`zlib.crc32`, nhanh hơn vòng lặp JavaScript ~8 lần, bớt khoảng 1 giây CPU mỗi ảnh 15 MB trên
gói free), ảnh kế tiếp được tải từ R2 trong lúc ảnh này đang gửi cho khách (giữ tối đa 2 ảnh trong
bộ nhớ). Album vượt 4 GB (khoảng 270 ảnh gốc) tự dùng ZIP64 nên tệp tải về vẫn mở được.

## Độ trễ tới database (vị trí máy chủ)

MongoDB Atlas M0 của tiệm đặt ở **Hồng Kông** (AWS ap-east-1). Đo trên bản chạy thật (10/2026):
mỗi lần máy chủ Render đi về database mất **~39 ms** (máy chủ đã ở gần, không cần đổi vùng). Mỗi yêu
cầu vẫn có thể cần vài lần đi về nối tiếp nhau, nên code đã giảm số lần đi về trên các đường nóng:

- Lưu một ảnh: 1 lần đọc (xác thực + kiểm tra ảnh trùng) và 1 lệnh cập nhật nguyên tử (đánh số,
  thêm ảnh, tính hạn lưu trong database) thay vì 4 lần.
- `/api/catalog` (mọi lần mở trang) và kiểm tra phiên quản trị (mọi yêu cầu quản trị) lưu tạm trong bộ
  nhớ (`src/services/read-cache.js`): mọi thay đổi qua Mongoose tự xoá bộ nhớ tạm ngay, tối đa 60 giây cho
  thay đổi từ nơi khác (sửa trực tiếp trên Atlas).
- Nhịp "máy chụp còn sống" 2 giây/lần: 1 lệnh thay vì 2.

`GET /api/health?db=1` trả `Server-Timing: db;dur=…` = thời gian một lần đi về database, đo được từ
trình duyệt. Nếu sau này con số này lên hàng trăm ms (máy chủ hoặc database bị chuyển vùng xa), hãy
đặt lại service Render và cụm Atlas cùng khu vực (Singapore / Hồng Kông).

## Theo dõi dung lượng ảnh

Trong **Hàng chờ in**, **Trợ lí Minh Dâm** đọc `GET /api/admin/storage` để hiển thị số file và
dung lượng ảnh (gồm ảnh gốc, ảnh xử lý, tờ in, video và file khác). Chỉ đọc `media.files.length`,
không tải dữ liệu trong `media.chunks`; các phiên bản GridFS trùng tên vẫn được tính riêng.
Các nhóm tính theo tham chiếu trong vé/lệnh in, mỗi file chỉ thuộc một nhóm.
Khi đã cấu hình R2, thống kê cộng metadata tệp R2 trong `R2_PREFIX` (cache tối đa 30 giây,
không tải nội dung) và GridFS. `media.stores` tách hai kho; `r2.quota` độc lập `quota` MongoDB.
Nhóm `thumbnails` xuất hiện khi có ảnh nhỏ. `media.available=false` báo thống kê chưa đủ do R2 lỗi;
dung lượng R2 chưa biết là `null`, không phải 0. `retention.available=false` khi chưa đo đủ hạn ảnh.
`PUT /api/admin/storage/r2-limit` lưu GB thập phân tại key `media-storage-r2`; null bỏ mức cảnh báo.
R2 mặc định theo dõi 10 GB dung lượng hiện tại, không phải quota cứng/hóa đơn GB-tháng.

`retention.nextImageExpiresAt` là hạn lưu gần nhất của ảnh còn trong GridFS: ảnh album và
ảnh gốc tính từ ObjectId từng ảnh, tờ in tính từ `createdAt` của lệnh ở mọi trạng thái.
Ảnh đã ẩn/xóa trong album nhưng file còn lưu vẫn được tính; video, file không có tham chiếu
và tham chiếu tới file đã mất không được tính. Trả `null` khi không có ảnh có hạn lưu.
Hạn đã qua vẫn được trả cho đến khi lịch dọn 15 phút xóa file, để giao diện báo đang chờ dọn.

Dung lượng **toàn cluster MongoDB Atlas Free/Flex** đọc bằng `db.command({ atlasSize: 1 })`,
gồm dữ liệu và index của **tất cả database**, theo [tài liệu MongoDB Atlas](https://www.mongodb.com/docs/atlas/free-tier-commands/).
Số liệu riêng database ứng dụng vẫn được trả trong `database` qua `dbStats.dataSize + indexSize`.
`1 MB = 1024 × 1024 byte`. Giới hạn mặc định **512 MB** theo gói Atlas Free của tiệm;
đổi cấu hình qua `MEDIA_STORAGE_LIMIT_MB` hoặc quản trị gọi `PUT /api/admin/storage/limit` với
`{ "limitMB": 512 }`. Cài đặt đã lưu ở key `media-storage` được ưu tiên, độc lập với studio;
`{ "limitMB": null }` bỏ giới hạn và không bị ghi đè lại bởi mặc định 512 MB.

Số MB còn lại = giới hạn − `cluster.usedBytes`, không âm. Quota có `scope: "cluster"` khi đọc
được `atlasSize`, `source: "config" | "setting"` cho biết nguồn giới hạn. MongoDB local hoặc
cluster không hỗ trợ/không cấp quyền sẽ trả `cluster.available: false` và dung lượng còn lại
chưa biết; không dùng dung lượng một database để giả định toàn cluster còn trống.
Cảnh báo từ 80%, nguy cấp từ 90%. Giới hạn chỉ để theo dõi, không tự chặn nhận ảnh.

Quản trị có thể gọi `POST /api/admin/storage/cleanup-expired` để chạy ngay cơ chế dọn TTL hiện có:
ảnh hết hạn theo ObjectId riêng từng ảnh, lệnh in hết hạn theo `createdAt`; giữ ảnh mới và thông tin
vé/doanh thu. `freedBytes` là mức giảm byte nội dung media thực đo; mức giảm quota nhà cung cấp
có thể khác do metadata/index và cách quản lý lưu trữ. API xem thống kê không xóa gì.

Các file liên quan: `src/services/media-storage.js`, `src/routes/admin/storage.js`,
`src/services/media.js` (TTL chung), `src/openapi.js`, `test/storage.test.js`.

## Thiết bị ở tiệm (chỉ máy Windows)

- Máy in của tiệm: **DNP DS-RX1**, giấy **PR (4x6)** = ảnh 15 × 10 cm (152 × 102 mm).
- `DNP_PRINTER_NAME`: tên máy in trong Windows (vd. `DS-RX1`) → lệnh in của khách tự gửi tới máy in
  (`scripts/print-dnp.ps1` chọn khổ 4x6 của driver, tờ khác chiều với giấy tự xoay). Để trống (máy chủ chạy trên
  Render) thì lễ tân in từ "Hàng chờ in" → “In 15×10”: trang in đúng 6 × 4 inch, chọn máy DS-RX1, khổ PR (4x6),
  tỉ lệ 100%, lề Không có. Nút tải của lệnh in nhiều tờ tải một tệp ZIP đủ các tờ.

Tùy chọn phục vụ cả frontend đã build: đặt `FRONTEND_DIST=../Photo_FE/dist` và
`CLIENT_URL=http://localhost:8080` trong `.env` rồi khởi động lại.

## Kiểm thử

```bash
npm test                      # API (MongoDB tạm)
npx playwright install chromium
npm run test:browser          # toàn luồng trên trình duyệt, cần build trước: cd ../Photo_FE && npm run build
```

Các bài test dùng MongoDB tạm, không đụng dữ liệu thật và luôn tắt máy in
(không in ra giấy dù `.env` có cấu hình thiết bị).

## Models và collection

Mỗi model nằm trong file riêng ở `src/models/`: `User.js`, `Room.js`, `Package.js`, `Frame.js`,
`Setting.js`, `Booking.js`, `PrintJob.js`; `index.js` tổng hợp export.

Tên collection: `users`, `rooms`, `packages`, `frames`, `settings`, `bookings`, `print_jobs`.
Các collection `shifts`, `pay_adjustments`, `payrolls` của tính năng chấm công & lương cũ (đã bỏ) không còn
được dùng — dữ liệu cũ vẫn nằm trong MongoDB, xóa tay nếu không cần.

Đổi tên collection từ phiên bản cũ: dừng backend, chạy `npm run migrate:collections`, rồi khởi động lại.
Migration giữ nguyên dữ liệu và index, không ghi đè collection đích đã tồn tại.

Nhật ký hoạt động đã được bỏ khỏi ứng dụng và không còn ghi dữ liệu mới.
Khi khởi động backend, ứng dụng xoá hai collection nhật ký cũ `audits` và `hf_audits`,
bao gồm cả dữ liệu và index. Có thể chạy riêng `npm run cleanup:activity-logs`
để xoá nhật ký trong MongoDB đang cấu hình mà không khởi động ứng dụng.
Lệnh này chỉ xoá hai collection trên; ảnh, vé, doanh thu và các collection khác được giữ nguyên.
Sau khi đưa code mới lên máy chủ, các backend cũ cần được dừng để không tiếp tục ghi nhật ký.
