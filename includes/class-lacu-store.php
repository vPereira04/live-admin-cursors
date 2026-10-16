<?php
/**
 * Presence table: one row per person in wp-admin with their latest cursor batch.
 *
 * @package LiveAdminCursors
 */

defined( 'ABSPATH' ) || exit;

/**
 * Reads and writes the presence table.
 *
 * Every query here is a live read or write of something that changes several
 * times a second, so caching it would defeat the point.
 * phpcs:disable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
 */
final class LACU_Store {

	const DB_VERSION     = '3';
	const VERSION_OPTION = 'lacu_db_version';

	// A tab that's gone quiet this long no longer counts as present.
	const ACTIVE_WINDOW = 12;

	/**
	 * Full table name for the current site.
	 */
	public static function table(): string {
		global $wpdb;
		return $wpdb->prefix . 'lacu_presence';
	}

	/**
	 * Creates or upgrades the table when the stored schema version is behind.
	 */
	public static function maybe_install(): void {
		if ( get_option( self::VERSION_OPTION ) === self::DB_VERSION ) {
			return;
		}

		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table   = self::table();
		$charset = $wpdb->get_charset_collate();

		dbDelta(
			"CREATE TABLE {$table} (
			user_id bigint(20) unsigned NOT NULL,
			room varchar(191) NOT NULL DEFAULT '',
			title varchar(191) NOT NULL DEFAULT '',
			focus varchar(100) NOT NULL DEFAULT '',
			visible tinyint(1) unsigned NOT NULL DEFAULT 1,
			seq bigint(20) unsigned NOT NULL DEFAULT 0,
			points text NOT NULL,
			moved_at int(10) unsigned NOT NULL DEFAULT 0,
			updated_at int(10) unsigned NOT NULL DEFAULT 0,
			PRIMARY KEY  (user_id),
			KEY updated_at (updated_at)
			) {$charset};"
		);

		update_option( self::VERSION_OPTION, self::DB_VERSION );
	}

	/**
	 * Stores the user's latest position, replacing whatever was there.
	 *
	 * @param int                                                                                                                                                           $user_id The user.
	 * @param array{room: string, title: string, focus: string, visible: bool, seq: int, points: array<int, array<int, float|int>>, anchors: array<int, string>, idle: int} $state   Their latest state.
	 */
	public static function save( int $user_id, array $state ): void {
		global $wpdb;

		$now = time();

		$wpdb->replace(
			self::table(),
			array(
				'user_id'    => $user_id,
				'room'       => $state['room'],
				'title'      => $state['title'],
				'focus'      => $state['focus'],
				'visible'    => $state['visible'] ? 1 : 0,
				'seq'        => max( 0, $state['seq'] ),
				'points'     => (string) wp_json_encode(
					array(
						'p' => $state['points'],
						'a' => $state['anchors'],
					)
				),
				'moved_at'   => max( 0, $now - $state['idle'] ),
				'updated_at' => $now,
			),
			array( '%d', '%s', '%s', '%s', '%d', '%d', '%s', '%d', '%d' )
		);
	}

	/**
	 * Drops the admin's row so they vanish for everyone straight away.
	 *
	 * @param int $user_id The admin.
	 */
	public static function forget( int $user_id ): void {
		global $wpdb;
		$wpdb->delete( self::table(), array( 'user_id' => $user_id ), array( '%d' ) );
	}

	/**
	 * Everyone except the given admin who has pulsed recently.
	 *
	 * @param int $user_id The admin asking.
	 * @return array<int, array{user_id: string, room: string, title: string, focus: string, visible: string, seq: string, points: string, moved_at: string}>
	 */
	public static function others( int $user_id ): array {
		global $wpdb;

		$rows = $wpdb->get_results(
			$wpdb->prepare(
				'SELECT user_id, room, title, focus, visible, seq, points, moved_at FROM %i WHERE updated_at >= %d AND user_id <> %d',
				self::table(),
				time() - self::ACTIVE_WINDOW,
				$user_id
			),
			ARRAY_A
		);

		return is_array( $rows ) ? $rows : array();
	}

	/**
	 * Clears rows left behind by tabs that closed without saying goodbye.
	 */
	public static function prune(): void {
		global $wpdb;
		$wpdb->query( $wpdb->prepare( 'DELETE FROM %i WHERE updated_at < %d', self::table(), time() - HOUR_IN_SECONDS ) );
	}
}
