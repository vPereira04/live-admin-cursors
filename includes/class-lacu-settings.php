<?php
/**
 * Settings > Live Admin Cursors: which roles have a cursor and which roles see them.
 *
 * @package LiveAdminCursors
 */

defined( 'ABSPATH' ) || exit;

/**
 * Stores the role settings and answers "can this user broadcast / view?".
 */
final class LACU_Settings {

	const OPTION    = 'lacu_settings';
	const PAGE_SLUG = 'live-admin-cursors';

	/**
	 * Wires up the hooks.
	 */
	public static function init(): void {
		add_action( 'admin_menu', array( __CLASS__, 'add_page' ) );
		add_action( 'admin_init', array( __CLASS__, 'register' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( LACU_FILE ), array( __CLASS__, 'add_plugin_link' ) );
	}

	/**
	 * Admins only until someone changes it.
	 *
	 * @return array{broadcast: array<int, string>, view: array<int, string>}
	 */
	public static function defaults(): array {
		return array(
			'broadcast' => array( 'administrator' ),
			'view'      => array( 'administrator' ),
		);
	}

	/**
	 * Saved settings, with the defaults filled in.
	 *
	 * @return array{broadcast: array<int, string>, view: array<int, string>}
	 */
	public static function get(): array {
		$saved    = get_option( self::OPTION );
		$defaults = self::defaults();

		if ( ! is_array( $saved ) ) {
			return $defaults;
		}

		return array(
			'broadcast' => isset( $saved['broadcast'] ) && is_array( $saved['broadcast'] ) ? array_values( array_map( 'strval', $saved['broadcast'] ) ) : $defaults['broadcast'],
			'view'      => isset( $saved['view'] ) && is_array( $saved['view'] ) ? array_values( array_map( 'strval', $saved['view'] ) ) : $defaults['view'],
		);
	}

	/**
	 * Whether this user's cursor is shown to others.
	 *
	 * @param WP_User|null $user Defaults to the current user.
	 */
	public static function can_broadcast( ?WP_User $user = null ): bool {
		return self::has_any_role( $user, self::get()['broadcast'] );
	}

	/**
	 * Whether this user sees other people's cursors.
	 *
	 * @param WP_User|null $user Defaults to the current user.
	 */
	public static function can_view( ?WP_User $user = null ): bool {
		return self::has_any_role( $user, self::get()['view'] );
	}

	/**
	 * Role check. Super admins count as administrators, since on multisite they often have no role on the site.
	 *
	 * @param WP_User|null       $user  The user.
	 * @param array<int, string> $roles Allowed role slugs.
	 */
	private static function has_any_role( ?WP_User $user, array $roles ): bool {
		$user = $user ? $user : wp_get_current_user();

		if ( ! $user->exists() ) {
			return false;
		}

		if ( in_array( 'administrator', $roles, true ) && is_multisite() && is_super_admin( $user->ID ) ) {
			return true;
		}

		return (bool) array_intersect( $roles, (array) $user->roles );
	}

	/**
	 * Adds the page under Settings.
	 */
	public static function add_page(): void {
		add_options_page(
			__( 'Live Admin Cursors', 'live-admin-cursors' ),
			__( 'Live Admin Cursors', 'live-admin-cursors' ),
			'manage_options',
			self::PAGE_SLUG,
			array( __CLASS__, 'render_page' )
		);
	}

	/**
	 * Registers the option.
	 */
	public static function register(): void {
		register_setting(
			self::PAGE_SLUG,
			self::OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( __CLASS__, 'sanitize' ),
				'default'           => self::defaults(),
			)
		);

		add_settings_section(
			'lacu_roles',
			__( 'Roles', 'live-admin-cursors' ),
			array( __CLASS__, 'render_section_intro' ),
			self::PAGE_SLUG
		);

		add_settings_field(
			'lacu_roles_table',
			__( 'Who takes part', 'live-admin-cursors' ),
			array( __CLASS__, 'render_roles_table' ),
			self::PAGE_SLUG,
			'lacu_roles'
		);
	}

	/**
	 * Keeps only roles that actually exist.
	 *
	 * @param mixed $input Raw form input.
	 * @return array{broadcast: array<int, string>, view: array<int, string>}
	 */
	public static function sanitize( $input ): array {
		$input = is_array( $input ) ? $input : array();
		$known = array_keys( wp_roles()->get_names() );
		$pick  = static function ( string $key ) use ( $input, $known ): array {
			$roles = isset( $input[ $key ] ) && is_array( $input[ $key ] ) ? array_map( 'sanitize_key', $input[ $key ] ) : array();
			return array_values( array_intersect( $known, $roles ) );
		};

		return array(
			'broadcast' => $pick( 'broadcast' ),
			'view'      => $pick( 'view' ),
		);
	}

	/**
	 * Adds a "Settings" link on the Plugins screen.
	 *
	 * @param array<string, string> $links Plugin action links.
	 * @return array<string, string>
	 */
	public static function add_plugin_link( array $links ): array {
		$link = sprintf(
			'<a href="%1$s">%2$s</a>',
			esc_url( admin_url( 'options-general.php?page=' . self::PAGE_SLUG ) ),
			esc_html__( 'Settings', 'live-admin-cursors' )
		);

		return array( 'settings' => $link ) + $links;
	}

	/**
	 * Prints the settings screen.
	 */
	public static function render_page(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		?>
		<div class="wrap">
			<h1><?php echo esc_html( get_admin_page_title() ); ?></h1>
			<form action="options.php" method="post">
				<?php
				settings_fields( self::PAGE_SLUG );
				do_settings_sections( self::PAGE_SLUG );
				submit_button();
				?>
			</form>
		</div>
		<?php
	}

	/**
	 * Short explanation above the table.
	 */
	public static function render_section_intro(): void {
		echo '<p>' . esc_html__( 'Cursors only show between people on the same wp-admin screen. Anyone who sees cursors can hide other people\'s cursors from the toolbar, and can hide their own if their role has a cursor.', 'live-admin-cursors' ) . '</p>';
	}

	/**
	 * One row per role with the two checkboxes.
	 */
	public static function render_roles_table(): void {
		$settings = self::get();
		$name     = self::OPTION;
		?>
		<table class="widefat striped lacu-roles" style="max-width: 560px;">
			<thead>
				<tr>
					<th scope="col"><?php esc_html_e( 'Role', 'live-admin-cursors' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Has a cursor', 'live-admin-cursors' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Sees cursors', 'live-admin-cursors' ); ?></th>
				</tr>
			</thead>
			<tbody>
				<?php foreach ( wp_roles()->get_names() as $role => $label ) : ?>
					<tr>
						<th scope="row"><?php echo esc_html( translate_user_role( $label ) ); ?></th>
						<td>
							<label>
								<input type="checkbox" name="<?php echo esc_attr( $name . '[broadcast][]' ); ?>" value="<?php echo esc_attr( $role ); ?>" <?php checked( in_array( $role, $settings['broadcast'], true ) ); ?> />
								<span class="screen-reader-text">
									<?php
									/* translators: %s: role name. */
									echo esc_html( sprintf( __( '%s has a cursor', 'live-admin-cursors' ), translate_user_role( $label ) ) );
									?>
								</span>
							</label>
						</td>
						<td>
							<label>
								<input type="checkbox" name="<?php echo esc_attr( $name . '[view][]' ); ?>" value="<?php echo esc_attr( $role ); ?>" <?php checked( in_array( $role, $settings['view'], true ) ); ?> />
								<span class="screen-reader-text">
									<?php
									/* translators: %s: role name. */
									echo esc_html( sprintf( __( '%s sees cursors', 'live-admin-cursors' ), translate_user_role( $label ) ) );
									?>
								</span>
							</label>
						</td>
					</tr>
				<?php endforeach; ?>
			</tbody>
		</table>
		<p class="description">
			<?php esc_html_e( '"Has a cursor": people with this role show up for others. "Sees cursors": people with this role see everyone else\'s cursors and get the toolbar menu.', 'live-admin-cursors' ); ?>
		</p>
		<?php
	}
}
