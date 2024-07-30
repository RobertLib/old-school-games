import db from "../db.ts";

interface VisitLog {
  path: string;
  method: string;
  userAgent: string;
  ip: string;
  referer: string;
  timestamp: Date;
}

interface PageStats {
  path: string;
  visits: number;
  unique_visitors: number;
}

interface DailyStats {
  date: string;
  visits: number;
  unique_visitors: number;
}

class Analytics {
  static async logVisit(data: VisitLog) {
    const query = `
      INSERT INTO analytics (path, method, user_agent, ip, referer, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;

    await db.query(query, [
      data.path,
      data.method,
      data.userAgent,
      data.ip,
      data.referer,
      data.timestamp,
    ]);
  }

  static async getPageStats(days = 30): Promise<PageStats[]> {
    const query = `
      SELECT
        path,
        COUNT(*) as visits,
        COUNT(DISTINCT ip) as unique_visitors
      FROM analytics
      WHERE created_at >= NOW() - make_interval(days => $1)
      GROUP BY path
      ORDER BY visits DESC
      LIMIT 20
    `;

    const result = await db.query(query, [days]);
    return result.rows;
  }

  static async getDailyStats(days = 30): Promise<DailyStats[]> {
    const query = `
      SELECT
        DATE(created_at) as date,
        COUNT(*) as visits,
        COUNT(DISTINCT ip) as unique_visitors
      FROM analytics
      WHERE created_at >= NOW() - make_interval(days => $1)
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `;

    const result = await db.query(query, [days]);
    return result.rows;
  }

  static async getTotalStats(days = 30) {
    const query = `
      SELECT
        COUNT(*) as total_visits,
        COUNT(DISTINCT ip) as unique_visitors,
        COUNT(DISTINCT DATE(created_at)) as active_days
      FROM analytics
      WHERE created_at >= NOW() - make_interval(days => $1)
    `;

    const result = await db.query(query, [days]);
    return result.rows[0];
  }

  static async getTopReferers(days = 30) {
    const query = `
      SELECT
        referer,
        COUNT(*) as visits
      FROM analytics
      WHERE created_at >= NOW() - make_interval(days => $1)
        AND referer != ''
        AND referer NOT LIKE '%oldschoolgames.eu%'
      GROUP BY referer
      ORDER BY visits DESC
      LIMIT 10
    `;

    const result = await db.query(query, [days]);
    return result.rows;
  }
}

export default Analytics;
