CREATE TABLE analytics (
  id SERIAL PRIMARY KEY,
  path VARCHAR(500) NOT NULL,
  method VARCHAR(10) NOT NULL,
  user_agent TEXT,
  ip VARCHAR(45),
  referer VARCHAR(500),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_analytics_path ON analytics(path);
CREATE INDEX idx_analytics_created_at ON analytics(created_at);
CREATE INDEX idx_analytics_ip ON analytics(ip);
