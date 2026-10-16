<?php
/**
 * Drops the presence table and the plugin's options on every site.
 *
 * @package LiveAdminCursors
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

/**
 * Cleans up the current site.
 */
function lacu_uninstall_site(): void {
	global $wpdb;

	// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.SchemaChange -- Uninstall has to drop the plugin's own table.
	$wpdb->query( $wpdb->prepare( 'DROP TABLE IF EXISTS %i', $wpdb->prefix . 'lacu_presence' ) );
	delete_option( 'lacu_db_version' );
	delete_option( 'lacu_settings' );
}

if ( is_multisite() ) {
	foreach ( get_sites(
		array(
			'fields' => 'ids',
			'number' => 0,
		)
	) as $lacu_site_id ) {
		switch_to_blog( (int) $lacu_site_id );
		lacu_uninstall_site();
		restore_current_blog();
	}
} else {
	lacu_uninstall_site();
}
