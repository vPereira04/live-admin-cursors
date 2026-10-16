<?php
/**
 * Plugin Name:       Live Admin Cursors
 * Description:       See each other's mouse cursors moving around wp-admin in real time when you're on the same screen. Pick which roles have a cursor and which roles see them.
 * Version:           1.0.0
 * Requires at least: 6.2
 * Requires PHP:      7.4
 * Author:            Victor Pereira
 * License:           GPLv2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       live-admin-cursors
 * Domain Path:       /languages
 *
 * @package LiveAdminCursors
 */

defined( 'ABSPATH' ) || exit;

define( 'LACU_FILE', __FILE__ );
define( 'LACU_VERSION', '1.0.0' );

require_once __DIR__ . '/includes/class-lacu-settings.php';
require_once __DIR__ . '/includes/class-lacu-store.php';
require_once __DIR__ . '/includes/class-lacu-rest.php';
require_once __DIR__ . '/includes/class-lacu-admin.php';

LACU_Settings::init();
LACU_Rest::init();
LACU_Admin::init();
