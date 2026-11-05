-- Migration: Add Java execution tracking and error columns to server_sessions
ALTER TABLE server_sessions ADD COLUMN java_pid INTEGER;
ALTER TABLE server_sessions ADD COLUMN server_data_dir TEXT;
ALTER TABLE server_sessions ADD COLUMN error_message TEXT;
