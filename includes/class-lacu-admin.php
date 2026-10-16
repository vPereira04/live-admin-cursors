<?php
/**
 * Loads the cursor script in wp-admin and adds the "who's here" toolbar item for viewers.
 *
 * @package LiveAdminCursors
 */

defined( 'ABSPATH' ) || exit;

/**
 * Admin-side wiring.
 */
final class LACU_Admin {

	const HANDLE = 'live-admin-cursors';

	/**
	 * Wires up the hooks.
	 */
	public static function init(): void {
		add_action( 'admin_init', array( 'LACU_Store', 'maybe_install' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue_assets' ) );
		add_action( 'admin_bar_menu', array( __CLASS__, 'add_admin_bar_item' ), 100 );
		add_action( 'wp_logout', array( __CLASS__, 'forget_on_logout' ) );
	}

	/**
	 * Only real, top-level wp-admin screens. Thickbox iframes and the network
	 * admin would otherwise show up as extra, phantom visitors.
	 */
	private static function is_active_screen(): bool {
		return is_admin()
			&& ! wp_doing_ajax()
			&& ! is_network_admin()
			&& ! is_user_admin()
			&& ! defined( 'IFRAME_REQUEST' )
			&& LACU_Rest::can_use();
	}

	/**
	 * Enqueues the script, styles and config.
	 */
	public static function enqueue_assets(): void {
		if ( ! self::is_active_screen() ) {
			return;
		}

		$url = plugin_dir_url( LACU_FILE );
		$dir = plugin_dir_path( LACU_FILE );

		// File times as versions, so browsers never keep running an old copy after an update.
		$css = 'assets/css/live-admin-cursors.css';
		$js  = 'assets/js/live-admin-cursors.js';

		wp_enqueue_style( self::HANDLE, $url . $css, array(), LACU_VERSION . '.' . (int) filemtime( $dir . $css ) );
		wp_enqueue_script( self::HANDLE, $url . $js, array(), LACU_VERSION . '.' . (int) filemtime( $dir . $js ), true );

		wp_localize_script(
			self::HANDLE,
			'lacuConfig',
			array(
				'root'     => esc_url_raw( rest_url( LACU_Rest::ROUTE_NAMESPACE . '/' ) ),
				'nonce'    => wp_create_nonce( 'wp_rest' ),
				'adminUrl' => esc_url_raw( admin_url() ),
				'canView'  => LACU_Settings::can_view() ? '1' : '',
				'canSend'  => LACU_Settings::can_broadcast() ? '1' : '',
				'i18n'     => array(
					'here'       => __( 'On this page', 'live-admin-cursors' ),
					'elsewhere'  => __( 'Elsewhere in wp-admin', 'live-admin-cursors' ),
					'alone'      => __( 'Nobody else is around', 'live-admin-cursors' ),
					'idle'       => __( 'idle', 'live-admin-cursors' ),
					'hideMe'     => __( 'Hide my cursor', 'live-admin-cursors' ),
					'showMe'     => __( 'Show my cursor', 'live-admin-cursors' ),
					'hideOthers' => __( 'Hide other cursors', 'live-admin-cursors' ),
					'showOthers' => __( 'Show other cursors', 'live-admin-cursors' ),
				),
			)
		);
	}

	/**
	 * Empty shell the script fills in with faces and the dropdown.
	 *
	 * @param WP_Admin_Bar $bar The admin bar.
	 */
	public static function add_admin_bar_item( WP_Admin_Bar $bar ): void {
		// People who can't see cursors have nothing to show or toggle here.
		if ( ! self::is_active_screen() || ! LACU_Settings::can_view() ) {
			return;
		}

		$bar->add_node(
			array(
				'id'     => 'lacu-presence',
				'parent' => 'top-secondary',
				'title'  => '<span class="ab-icon" aria-hidden="true"></span><span class="lacu-bar__faces"></span><span class="lacu-bar__count">0</span>',
				'href'   => '#',
				'meta'   => array(
					'class' => 'lacu-bar lacu-bar--alone',
					'title' => __( 'Live Admin Cursors', 'live-admin-cursors' ),
				),
			)
		);

		// A child node makes WP render the dropdown wrapper and its hover handling.
		$bar->add_node(
			array(
				'id'     => 'lacu-presence-alone',
				'parent' => 'lacu-presence',
				'title'  => esc_html__( 'Nobody else is around', 'live-admin-cursors' ),
			)
		);
	}

	/**
	 * Logging out removes the cursor straight away instead of letting it time out.
	 *
	 * @param int $user_id The admin logging out.
	 */
	public static function forget_on_logout( $user_id ): void {
		if ( $user_id ) {
			LACU_Store::forget( (int) $user_id );
		}
	}
}
