-- Migration: Add Java execution tracking columns to server_sessions
ALTER TABLE server_sessions ADD COLUMN java_pid INTEGER;
ALTER TABLE server_sessions ADD COLUMN server_data_dir TEXT;
