import { Booking, PrintJob, Room } from "../models/index.js";

export async function getStudioStats(currentDate, days) {
  const [result, rooms, printQueue] = await Promise.all([
    Booking.aggregate([
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                bookings: { $sum: 1 },
                revenue: { $sum: { $cond: ["$paid", "$total", 0] } },
                pending: {
                  $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
                },
              },
            },
          ],
          daily: [
            {
              $match: {
                paid: true,
                date: { $gte: days[0], $lte: currentDate },
              },
            },
            { $group: { _id: "$date", revenue: { $sum: "$total" } } },
          ],
          occupancy: [
            { $match: { date: currentDate, status: { $ne: "cancelled" } } },
            { $group: { _id: "$room", booked: { $sum: 1 } } },
          ],
        },
      },
    ]),
    Room.find({ active: true }).select("name branch").lean(),
    PrintJob.countDocuments({ status: "pending" }),
  ]);
  const data = result[0];
  const totals = data.totals[0] || { bookings: 0, revenue: 0, pending: 0 };
  const revenues = new Map(data.daily.map((row) => [row._id, row.revenue]));
  const occupancy = new Map(
    data.occupancy.map((row) => [String(row._id), row.booked]),
  );
  return {
    bookings: totals.bookings,
    revenue: totals.revenue,
    pending: totals.pending,
    printQueue,
    // Doanh thu trong ngày: tiền đã nhận của các vé cấp hôm nay (kể cả tờ in bán thêm).
    todayRevenue: revenues.get(currentDate) || 0,
    today: data.occupancy.reduce((sum, row) => sum + row.booked, 0),
    byDate: days.map((date) => ({ date, revenue: revenues.get(date) || 0 })),
    occupancy: rooms.map((room) => {
      const booked = occupancy.get(String(room._id)) || 0;
      return {
        name: room.name,
        branch: room.branch,
        booked,
      };
    }),
  };
}

// Doanh thu từng ngày của một tháng (YYYY-MM): đủ mọi ngày từ 1 đến cuối tháng, ngày không
// có khách trả về 0. Tính theo ngày cấp mã (giờ Việt Nam), chỉ vé đã nhận tiền.
export async function getMonthRevenue(month) {
  const [year, m] = month.split("-").map(Number);
  const count = new Date(Date.UTC(year, m, 0)).getUTCDate();
  const day = (d) => `${month}-${String(d).padStart(2, "0")}`;
  const rows = await Booking.aggregate([
    { $match: { paid: true, date: { $gte: day(1), $lte: day(count) } } },
    {
      $group: {
        _id: "$date",
        revenue: { $sum: "$total" },
        tickets: { $sum: 1 },
      },
    },
  ]);
  const byDate = new Map(rows.map((row) => [row._id, row]));
  const days = Array.from({ length: count }, (_, i) => {
    const date = day(i + 1);
    const row = byDate.get(date);
    return { date, revenue: row?.revenue || 0, tickets: row?.tickets || 0 };
  });
  return {
    month,
    revenue: days.reduce((sum, d) => sum + d.revenue, 0),
    tickets: days.reduce((sum, d) => sum + d.tickets, 0),
    days,
  };
}
