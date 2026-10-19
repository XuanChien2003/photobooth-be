import rateLimit from "express-rate-limit";

export const apiLimit = rateLimit({
  windowMs: 60000,
  limit: 180,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    message: "Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.",
  },
  // Cả studio dùng chung một IP (wifi): máy chụp gửi ảnh liên tục + báo trạng thái 2 giây/lần,
  // quầy và điện thoại khách tự làm mới. Chỉ tính yêu cầu không có lớp bảo vệ riêng:
  // kiosk cần mã phiên chụp đã ký, quản trị cần đăng nhập, album cần mã truy cập 48 ký tự.
  // Nhập mã ở kiosk, tra cứu vé và đăng nhập vẫn có giới hạn chống dò mã riêng.
  // /health: mọi máy trong tiệm dò lại máy chủ khi mất kết nối (chung một IP Wi-Fi), rất nhẹ.
  skip: (req) =>
    req.path === "/health" ||
    /^\/(admin\/|kiosk\/(?!claim))/.test(req.path) ||
    (req.method === "GET" && /^\/albums\//.test(req.path)),
});

export const sensitive = () =>
  rateLimit({
    windowMs: 15 * 60000,
    limit: 25,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      message:
        "Quá nhiều lần thử không thành công. Vui lòng thử lại sau 15 phút.",
    },
  });
export const bookingLimit = rateLimit({
  windowMs: 15 * 60000,
  limit: 60,
  message: {
    message: "Quá nhiều yêu cầu cấp mã từ thiết bị này. Vui lòng thử lại sau.",
  },
});

export const printLimit = rateLimit({
  windowMs: 10 * 60000,
  limit: 10,
  keyGenerator: (req) => req.params.token,
  message: {
    message: "Bạn gửi in quá nhiều lần. Vui lòng thử lại sau ít phút.",
  },
});
