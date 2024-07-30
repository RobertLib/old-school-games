CREATE INDEX idx_games_genre ON games(genre);
CREATE INDEX idx_games_developer ON games(developer);
CREATE INDEX idx_games_publisher ON games(publisher);
CREATE INDEX idx_games_release ON games(release);
CREATE INDEX idx_games_slug ON games(slug);
CREATE INDEX idx_ratings_game_id ON ratings("gameId");
