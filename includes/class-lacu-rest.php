<?php
/**
 * REST endpoints the cursor script talks to.
 *
 * @package LiveAdminCursors
 */

defined( 'ABSPATH' ) || exit;

/**
 * Pulse (send my cursor, get everyone else's) and leave.
 */
final class LACU_Rest {

	const ROUTE_NAMESPACE = 'live-admin-cursors/v1';

	const MAX_POINTS = 60;

	const MAX_ANCHORS = 20;

	/**
	 * Wires up the hooks.
	 */
	public static function init(): void {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	/**
	 * Whether the current user takes part at all, sending or seeing.
	 */
	public static function can_use(): bool {
		return LACU_Settings::can_broadcast() || LACU_Settings::can_view();
	}

	/**
	 * Registers the routes.
	 */
	public static function register_routes(): void {
		register_rest_route(
			self::ROUTE_NAMESPACE,
			'/pulse',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'pulse' ),
				'permission_callback' => array( __CLASS__, 'can_use' ),
				'args'                => array(
					'room'    => array(
						'type'              => 'string',
						'required'          => true,
						'sanitize_callback' => array( __CLASS__, 'sanitize_room' ),
						'validate_callback' => array( __CLASS__, 'validate_room' ),
					),
					'title'   => array(
						'type'              => 'string',
						'default'           => '',
						'sanitize_callback' => 'sanitize_text_field',
					),
					'seq'     => array(
						'type'    => 'integer',
						'default' => 0,
						'minimum' => 0,
					),
					'focus'   => array(
						'type'              => 'string',
						'default'           => '',
						'sanitize_callback' => array( __CLASS__, 'sanitize_focus' ),
					),
					'idle'    => array(
						'type'    => 'integer',
						'default' => 0,
						'minimum' => 0,
					),
					'ghost'   => array(
						'type'    => 'boolean',
						'default' => false,
					),
					'points'  => array(
						'type'     => 'array',
						'default'  => array(),
						'maxItems' => self::MAX_POINTS,
						'items'    => array(
							'type'  => 'array',
							'items' => array( 'type' => 'number' ),
						),
					),
					'anchors' => array(
						'type'     => 'array',
						'default'  => array(),
						'maxItems' => self::MAX_ANCHORS,
						'items'    => array( 'type' => 'string' ),
					),
				),
			)
		);

		register_rest_route(
			self::ROUTE_NAMESPACE,
			'/leave',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'leave' ),
				'permission_callback' => array( __CLASS__, 'can_use' ),
			)
		);
	}

	/**
	 * Saves my cursor and hands back everyone else's, if I'm allowed to see them.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response
	 */
	public static function pulse( WP_REST_Request $request ): WP_REST_Response {
		LACU_Store::maybe_install();

		$me   = get_current_user_id();
		$room = (string) $request['room'];

		$can_view = LACU_Settings::can_view();

		// Ghost mode is a viewer toggle, so it only counts for people who can see the toolbar.
		$visible = LACU_Settings::can_broadcast() && ! ( $request['ghost'] && $can_view );

		// Everyone gets a row, even when hidden, so senders know when someone's watching.
		LACU_Store::save(
			$me,
			array(
				'room'    => $room,
				'title'   => mb_substr( (string) $request['title'], 0, 191 ),
				'focus'   => $visible ? (string) $request['focus'] : '',
				'visible' => $visible,
				'seq'     => (int) $request['seq'],
				'points'  => $visible ? self::clean_points( (array) $request['points'] ) : array(),
				'anchors' => $visible ? self::clean_anchors( (array) $request['anchors'] ) : array(),
				'idle'    => min( (int) $request['idle'], DAY_IN_SECONDS ),
			)
		);

		if ( 1 === wp_rand( 1, 50 ) ) {
			LACU_Store::prune();
		}

		$here      = array();
		$elsewhere = array();
		$watched   = false;
		$now       = time();

		foreach ( LACU_Store::others( $me ) as $row ) {
			$user = get_userdata( (int) $row['user_id'] );

			if ( ! $user ) {
				continue;
			}

			if ( $row['room'] === $room && ! $watched && LACU_Settings::can_view( $user ) ) {
				$watched = true;
			}

			// Viewers only see visible people who still have a cursor role.
			if ( ! $can_view || ! (int) $row['visible'] || ! LACU_Settings::can_broadcast( $user ) ) {
				continue;
			}

			$person = array(
				'id'     => (int) $user->ID,
				'name'   => $user->display_name,
				'avatar' => (string) get_avatar_url( $user->ID, array( 'size' => 48 ) ),
				'color'  => self::color_for( $user ),
				'room'   => $row['room'],
				'title'  => $row['title'],
			);

			if ( $row['room'] !== $room ) {
				$elsewhere[] = $person;
				continue;
			}

			$batch = json_decode( $row['points'], true );

			$here[] = $person + array(
				'seq'     => (int) $row['seq'],
				'focus'   => $row['focus'],
				'points'  => isset( $batch['p'] ) && is_array( $batch['p'] ) ? $batch['p'] : array(),
				'anchors' => isset( $batch['a'] ) && is_array( $batch['a'] ) ? $batch['a'] : array(),
				'idle'    => max( 0, $now - (int) $row['moved_at'] ),
			);
		}

		return rest_ensure_response(
			array(
				'here'      => $here,
				'elsewhere' => $elsewhere,
				'watched'   => $watched,
			)
		);
	}

	/**
	 * Removes me right away, e.g. when the tab is closed or hidden.
	 *
	 * @return WP_REST_Response
	 */
	public static function leave(): WP_REST_Response {
		LACU_Store::forget( get_current_user_id() );
		return rest_ensure_response( array( 'ok' => true ) );
	}

	/**
	 * Keeps a room to a relative wp-admin path, so it's always safe to link to.
	 *
	 * @param mixed $room Raw room from the client.
	 */
	public static function sanitize_room( $room ): string {
		$room = ltrim( is_string( $room ) ? $room : '', '/' );

		if ( '' === $room || strlen( $room ) > 191 || false !== strpos( $room, '..' ) ) {
			return '';
		}

		return preg_match( '#^[\w\-./]+(\?[\w\-.~%&=+]*)?$#', $room ) ? $room : '';
	}

	/**
	 * The focused field, as an element ID or "name:<field name>". Nothing else gets through.
	 *
	 * @param mixed $focus Raw focus from the client.
	 */
	public static function sanitize_focus( $focus ): string {
		$focus = is_string( $focus ) ? $focus : '';
		return preg_match( '#^(name:)?[\w\-\[\].:]{1,100}$#', $focus ) ? $focus : '';
	}

	/**
	 * A vivid colour from the username. Saturation stays high so it never lands on a muddy grey,
	 * and yellows to cyans go darker so the white name tag stays readable.
	 *
	 * @param WP_User $user The user.
	 */
	public static function color_for( WP_User $user ): string {
		$hue   = (int) hexdec( substr( md5( $user->user_login ), 0, 6 ) ) % 360;
		$light = ( $hue >= 45 && $hue <= 200 ) ? 38 : 52;

		return sprintf( 'hsl(%d, 88%%, %d%%)', $hue, $light );
	}

	/**
	 * Rejects rooms that wouldn't survive sanitising.
	 *
	 * @param mixed $room Raw room from the client.
	 */
	public static function validate_room( $room ): bool {
		return '' !== self::sanitize_room( $room );
	}

	/**
	 * Element anchors: "<element id>" or "<element id>|<child path>", e.g. "the-list|2tr/0td".
	 * Anything else becomes an empty string, so the samples pointing at it fall back to raw coordinates.
	 *
	 * @param array<int, mixed> $anchors Raw anchors.
	 * @return array<int, string>
	 */
	private static function clean_anchors( array $anchors ): array {
		$clean = array();

		foreach ( array_slice( $anchors, 0, self::MAX_ANCHORS ) as $anchor ) {
			$anchor  = is_string( $anchor ) ? $anchor : '';
			$clean[] = strlen( $anchor ) <= 150 && preg_match( '#^[A-Za-z][\w\-:.]*(\|\d+[a-z][a-z0-9\-]*(/\d+[a-z][a-z0-9\-]*)*)?$#', $anchor ) ? $anchor : '';
		}

		return $clean;
	}

	/**
	 * Clamps each sample to [x ratio, y px, ms offset, flags], plus
	 * [x ratio, y ratio, anchor index] inside its element when it has one.
	 *
	 * @param array<int, mixed> $points Raw samples.
	 * @return array<int, array<int, float|int>>
	 */
	private static function clean_points( array $points ): array {
		$clean = array();

		foreach ( array_slice( $points, 0, self::MAX_POINTS ) as $point ) {
			if ( ! is_array( $point ) || count( $point ) < 4 ) {
				continue;
			}

			$sample = array(
				round( max( 0.0, min( 1.0, (float) $point[0] ) ), 4 ),
				(int) max( -1000, min( 1000000, (float) $point[1] ) ),
				(int) max( 0, min( 10000, (float) $point[2] ) ),
				( (int) $point[3] ) & 127,
			);

			if ( count( $point ) >= 7 ) {
				$sample[] = round( max( -2.0, min( 3.0, (float) $point[4] ) ), 4 );
				$sample[] = round( max( -2.0, min( 3.0, (float) $point[5] ) ), 4 );
				$sample[] = (int) max( 0, min( self::MAX_ANCHORS - 1, (int) $point[6] ) );
			}

			$clean[] = $sample;
		}

		return $clean;
	}
}
