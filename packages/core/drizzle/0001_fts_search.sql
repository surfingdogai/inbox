CREATE VIRTUAL TABLE `search_fts` USING fts5(subject, body, party, item_id UNINDEXED, entry_id UNINDEXED, tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `thread_entries_ai` AFTER INSERT ON `thread_entries` BEGIN
  INSERT INTO `search_fts` (subject, body, party, item_id, entry_id)
  VALUES (new.subject, new.body_text, (SELECT display_name FROM parties WHERE id = new.party_id), new.item_id, new.id);
END;
--> statement-breakpoint
CREATE TRIGGER `thread_entries_ad` AFTER DELETE ON `thread_entries` BEGIN
  DELETE FROM `search_fts` WHERE entry_id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER `thread_entries_au` AFTER UPDATE OF subject, body_text ON `thread_entries` BEGIN
  DELETE FROM `search_fts` WHERE entry_id = old.id;
  INSERT INTO `search_fts` (subject, body, party, item_id, entry_id)
  VALUES (new.subject, new.body_text, (SELECT display_name FROM parties WHERE id = new.party_id), new.item_id, new.id);
END;
