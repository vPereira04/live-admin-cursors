/**
 * Live Admin Cursors: sends my cursor in small batches and replays everyone
 * else's on the same wp-admin screen.
 */
( function () {
	'use strict';

	const cfg = window.lacuConfig;
	if ( ! cfg || ! window.fetch || ! window.requestAnimationFrame ) {
		return;
	}

	const canView = !! cfg.canView;
	const canSend = !! cfg.canSend;

	if ( ! canView && ! canSend ) {
		return;
	}

	// Poll rates: someone's moving / company but still / nobody around.
	const FAST = 90;
	const STILL = 400;
	const SLOW = 1500;
	const MAX_INFLIGHT = 2;

	const SAMPLE = 30; // Min ms between my move samples.
	const TYPE_SAMPLE = 100;
	const MAX_POINTS = 50;
	const MAX_ANCHORS = 20;
	const PLAYBACK_DELAY = 50; // Tiny jitter buffer so replayed paths don't stutter.
	const MAX_LAG = 150;
	const MAX_BATCH_SPAN = 300;
	const IDLE_AFTER = 30; // Seconds before a still cursor fades.
	const TYPING_FOR = 1200;

	// Notice/nonce params that don't change which screen you're on.
	const VOLATILE_PARAMS = [
		'_wpnonce',
		'_wp_http_referer',
		'message',
		'updated',
		'settings-updated',
		'deleted',
		'trashed',
		'untrashed',
		'activated',
		'activate',
		'deactivate',
		'ids',
		'locked',
		'error',
		'saved',
		'added',
	];

	// Block editor: 1 = its scrolling content area, 2 = the iframed canvas.
	const SURFACE_DOC = 0;
	const SURFACE_EDITOR = 1;
	const SURFACE_CANVAS = 2;
	const EDITOR_SELECTOR = '.interface-interface-skeleton__content';

	// What the mouse looks like: plain arrow, hand over something clickable, I-beam over text.
	const KIND_ARROW = 0;
	const KIND_POINTER = 1;
	const KIND_TEXT = 2;
	const KIND_CLASSES = [ '', 'lacu-cursor--pointer', 'lacu-cursor--text' ];

	// Each sample's flags = surface + 4 * kind + one of these.
	const EV_CLICK = 16;
	const EV_TYPE = 32;
	const EV_AWAY = 64;

	const CLICKABLE =
		'a[href], button, [role="button"], [role="tab"], [role="menuitem"], select, summary, label, input[type="checkbox"], input[type="radio"], input[type="submit"], input[type="button"]';
	const TEXT_INPUTS = [ 'text', 'search', 'email', 'url', 'tel', 'password', 'number', '' ];

	// IDs good enough to anchor on. Block IDs are random per session, so they're no use to anyone else.
	const STABLE_ID = /^[A-Za-z][\w\-:.]{0,80}$/;
	const SESSION_ID = /^block-|[0-9a-f]{8}-[0-9a-f]{4}-/;

	const i18n = cfg.i18n || {};
	const room = currentRoom();
	const peers = new Map();
	const hookedDocs = new WeakSet();
	const anchorCache = new Map();

	let nonce = cfg.nonce;
	let ghost = canView && canSend && readPref( 'ghost' );
	let hideOthers = canView && readPref( 'hideOthers' );

	// Batch numbers are timestamps, so a reload never reuses one someone already played.
	let seq = 0;
	let batch = [];
	let batchAnchors = [];
	let batchStart = 0;
	let lastBatch = [];
	let lastAnchors = [];
	let lastSampleAt = 0;
	let lastTypeAt = 0;
	let trailingTimer = null;
	let lastPointer = null;
	let lastSource = 'mouse'; // mouse, touch, pen or type.
	let lastMoveAt = 0;
	let myFocus = '';
	let kindTarget = null;
	let kindCache = KIND_ARROW;

	let timer = null;
	let timerAt = 0;
	let inflight = 0;
	let lastSentAt = 0;
	let requestCount = 0;
	let appliedRequest = 0;
	let failures = 0;
	let watched = false;
	let remoteActiveUntil = 0;
	let here = [];
	let elsewhere = [];
	let barSignature = '';
	let rafId = 0;

	let layer = null;
	if ( canView ) {
		layer = document.createElement( 'div' );
		layer.className = 'lacu-layer';
		layer.setAttribute( 'aria-hidden', 'true' );
		layer.hidden = hideOthers;
		document.body.appendChild( layer );
	}

	/* ---------- Helpers ---------- */

	function readPref( key ) {
		try {
			return window.localStorage.getItem( 'lacu:' + key ) === '1';
		} catch ( e ) {
			return false;
		}
	}

	function writePref( key, on ) {
		try {
			if ( on ) {
				window.localStorage.setItem( 'lacu:' + key, '1' );
			} else {
				window.localStorage.removeItem( 'lacu:' + key );
			}
		} catch ( e ) {}
	}

	function clamp( n, min, max ) {
		return Math.min( max, Math.max( min, n ) );
	}

	function bit( flags, value ) {
		return Math.floor( flags / value ) % 2 === 1;
	}

	// Same screen = same file under /wp-admin/ plus the params that matter.
	function currentRoom() {
		const path = window.location.pathname;
		const at = path.indexOf( '/wp-admin/' );
		const file = ( at >= 0 ? path.slice( at + 10 ) : '' ) || 'index.php';
		const params = new URLSearchParams( window.location.search );

		VOLATILE_PARAMS.forEach( ( key ) => params.delete( key ) );
		params.sort();

		const query = params.toString();
		return ( file + ( query ? '?' + query : '' ) ).slice( 0, 191 );
	}

	function screenTitle() {
		return document.title.split( ' ‹ ' )[ 0 ].trim().slice( 0, 150 );
	}

	function colorOf( person ) {
		return person.color || '#2271b1';
	}

	function canvasFrame() {
		return document.querySelector( 'iframe[name="editor-canvas"]' );
	}

	function isEditable( el ) {
		if ( ! el || el.nodeType !== 1 ) {
			return false;
		}

		if ( el.isContentEditable || el.tagName === 'TEXTAREA' ) {
			return true;
		}

		return el.tagName === 'INPUT' && TEXT_INPUTS.indexOf( ( el.getAttribute( 'type' ) || '' ).toLowerCase() ) !== -1;
	}

	function computeKind( el ) {
		if ( ! el || el.nodeType !== 1 ) {
			return KIND_ARROW;
		}

		if ( isEditable( el ) ) {
			return KIND_TEXT;
		}

		const view = el.ownerDocument.defaultView;
		const cursor = view ? view.getComputedStyle( el ).cursor : '';

		if ( cursor === 'text' || cursor === 'vertical-text' ) {
			return KIND_TEXT;
		}

		if ( cursor === 'pointer' || cursor === 'move' || cursor.indexOf( 'grab' ) === 0 || el.closest( CLICKABLE ) ) {
			return KIND_POINTER;
		}

		return KIND_ARROW;
	}

	// Computed styles aren't free, so I only recheck when the hovered element changes.
	function kindOf( el ) {
		if ( el !== kindTarget ) {
			kindTarget = el;
			kindCache = computeKind( el );
		}
		return kindCache;
	}

	// The on-screen box of a surface and how far it's scrolled.
	function surfaceBox( surface ) {
		if ( surface === SURFACE_EDITOR ) {
			const el = document.querySelector( EDITOR_SELECTOR );
			if ( el ) {
				const r = el.getBoundingClientRect();
				return { left: r.left, top: r.top, width: r.width, height: r.height, scroll: el.scrollTop, scroller: el };
			}
		}

		if ( surface === SURFACE_CANVAS ) {
			const frame = canvasFrame();
			const win = frame && frame.contentWindow;
			if ( win && win.document && win.document.scrollingElement ) {
				const r = frame.getBoundingClientRect();
				return {
					left: r.left + frame.clientLeft,
					top: r.top + frame.clientTop,
					width: frame.clientWidth,
					height: frame.clientHeight,
					scroll: win.scrollY,
					scroller: win.document.scrollingElement,
				};
			}
		}

		return {
			left: 0,
			top: 0,
			width: document.documentElement.clientWidth,
			height: window.innerHeight,
			scroll: window.scrollY,
			scroller: document.scrollingElement || document.documentElement,
		};
	}

	/* ---------- Capturing my cursor ---------- */

	function sending() {
		return canSend && ! ghost;
	}

	/*
	 * Screens differ in size, so raw coordinates drift once the layout reflows. I pin
	 * each sample to the element under it instead: the nearest ancestor with a stable
	 * ID, plus the child path down from there ("the-list|2tr/0td").
	 */
	function anchorFor( el ) {
		const steps = [];
		let node = el;

		while ( node && node.nodeType === 1 && steps.length < 12 ) {
			if ( node.id && STABLE_ID.test( node.id ) && ! SESSION_ID.test( node.id ) ) {
				const anchor = node.id + ( steps.length ? '|' + steps.reverse().join( '/' ) : '' );
				return anchor.length <= 150 ? anchor : '';
			}

			const parent = node.parentElement;
			if ( ! parent ) {
				break;
			}

			steps.push( Array.prototype.indexOf.call( parent.children, node ) + node.tagName.toLowerCase() );
			node = parent;
		}

		return '';
	}

	function canvasDoc() {
		const frame = canvasFrame();
		try {
			return frame ? frame.contentDocument : null;
		} catch ( e ) {
			return null;
		}
	}

	// Where an element sits in the main window, even if it lives in the editor canvas.
	function rectOf( el, surface, box ) {
		const r = el.getBoundingClientRect();
		const left = surface === SURFACE_CANVAS ? box.left : 0;
		const top = surface === SURFACE_CANVAS ? box.top : 0;
		return { left: r.left + left, top: r.top + top, width: r.width, height: r.height };
	}

	// What's under a point now, e.g. after the page scrolled beneath a still mouse.
	function elementAt( surface, clientX, clientY ) {
		if ( surface === SURFACE_CANVAS ) {
			const doc = canvasDoc();
			const box = surfaceBox( SURFACE_CANVAS );
			return doc ? doc.elementFromPoint( clientX - box.left, clientY - box.top ) : null;
		}
		return document.elementFromPoint( clientX, clientY );
	}

	function record( surface, clientX, clientY, kind, ev, target ) {
		lastPointer = { surface, clientX, clientY, kind, target };

		if ( ! sending() ) {
			return;
		}

		const now = performance.now();

		// Throttle plain moves, but always land the final resting point.
		if ( ! ev && now - lastSampleAt < SAMPLE ) {
			if ( ! trailingTimer ) {
				trailingTimer = setTimeout( () => {
					trailingTimer = null;
					record( lastPointer.surface, lastPointer.clientX, lastPointer.clientY, lastPointer.kind, 0, lastPointer.target );
				}, SAMPLE );
			}
			return;
		}

		const box = surfaceBox( surface );
		const x = box.width ? clamp( ( clientX - box.left ) / box.width, 0, 1 ) : 0;
		const y = Math.round( clientY - box.top + box.scroll );

		lastSampleAt = now;
		if ( ! batch.length ) {
			batchStart = now;
			batchAnchors = [];
		}

		const point = [ Number( x.toFixed( 4 ) ), y, Math.round( now - batchStart ), surface + 4 * kind + ev ];
		const anchor = target ? anchorFor( target ) : '';

		if ( anchor ) {
			const r = rectOf( target, surface, box );
			let index = batchAnchors.indexOf( anchor );

			if ( index === -1 && batchAnchors.length < MAX_ANCHORS ) {
				index = batchAnchors.push( anchor ) - 1;
			}

			if ( index !== -1 && ( r.width || r.height ) ) {
				const rx = r.width ? clamp( ( clientX - r.left ) / r.width, -2, 3 ) : 0;
				const ry = r.height ? clamp( ( clientY - r.top ) / r.height, -2, 3 ) : 0;
				point.push( Number( rx.toFixed( 4 ) ), Number( ry.toFixed( 4 ) ), index );
			}
		}

		batch.push( point );
		if ( batch.length > MAX_POINTS ) {
			batch.shift();
		}

		lastMoveAt = Date.now();
		schedule( watched ? 0 : STILL );
	}

	// Where the text caret is, so a typing cursor sits right where the letters appear.
	function caretPoint( doc, el ) {
		let rect = null;

		if ( el.isContentEditable ) {
			const sel = doc.getSelection();
			if ( sel && sel.rangeCount ) {
				const range = sel.getRangeAt( 0 ).cloneRange();
				range.collapse( false );
				const rects = range.getClientRects();
				rect = rects.length ? rects[ rects.length - 1 ] : null;
			}
		}

		if ( rect && ( rect.top || rect.left ) ) {
			return { x: rect.right, y: rect.top + rect.height / 2 };
		}

		const r = el.getBoundingClientRect();
		return { x: r.left + Math.min( r.width - 4, 14 ), y: r.top + Math.min( r.height / 2, 16 ) };
	}

	function onType( e, surface, offsetX, offsetY ) {
		const doc = e.target.ownerDocument;
		const el = doc.activeElement;

		if ( ! isEditable( el ) ) {
			return;
		}

		const now = performance.now();
		if ( now - lastTypeAt < TYPE_SAMPLE ) {
			return;
		}

		lastTypeAt = now;
		lastSource = 'type';
		const at = caretPoint( doc, el );
		record( surface, at.x + offsetX, at.y + offsetY, KIND_TEXT, EV_TYPE, el );
	}

	function surfaceOf( target ) {
		return target && target.closest && target.closest( EDITOR_SELECTOR ) ? SURFACE_EDITOR : SURFACE_DOC;
	}

	// Pointer events, so fingers and pens on phones and tablets count as well as mice.
	document.addEventListener(
		'pointermove',
		( e ) => {
			lastSource = e.pointerType;
			record( surfaceOf( e.target ), e.clientX, e.clientY, kindOf( e.target ), 0, e.target );
		},
		{ passive: true }
	);
	document.addEventListener(
		'pointerdown',
		( e ) => {
			lastSource = e.pointerType;
			record( surfaceOf( e.target ), e.clientX, e.clientY, kindOf( e.target ), EV_CLICK, e.target );
		},
		{ passive: true }
	);
	// "input" rather than keydown: on-screen keyboards often send no usable key events.
	document.addEventListener( 'input', ( e ) => onType( e, surfaceOf( e.target ), 0, 0 ), { passive: true } );

	// Mouse left the window.
	document.addEventListener( 'pointerout', ( e ) => {
		if ( e.pointerType === 'mouse' && ! e.relatedTarget && lastPointer ) {
			record( lastPointer.surface, lastPointer.clientX, lastPointer.clientY, KIND_ARROW, EV_AWAY, lastPointer.target );
		}
	} );

	/*
	 * Scrolling slides new content under a still mouse, so I resample what's under it.
	 * Not for fingers (nothing is hovering once they lift) or right after typing (the
	 * cursor is pinned to the field, wherever the page scrolls).
	 */
	function followsScroll() {
		return lastPointer && lastSource === 'mouse';
	}

	window.addEventListener(
		'scroll',
		() => {
			if ( followsScroll() && lastPointer.surface !== SURFACE_CANVAS ) {
				const { surface, clientX, clientY, kind } = lastPointer;
				record( surface, clientX, clientY, kind, 0, elementAt( surface, clientX, clientY ) );
			}
		},
		{ capture: true, passive: true }
	);

	// Which field I'm in, so others can see it ringed in my colour.
	function focusKey( el ) {
		if ( ! isEditable( el ) && ! ( el && el.tagName === 'SELECT' ) ) {
			return '';
		}

		const key = el.id || ( el.name ? 'name:' + el.name : '' );
		return /^(name:)?[\w\-\[\].:]{1,100}$/.test( key ) ? key : '';
	}

	document.addEventListener( 'focusin', ( e ) => {
		myFocus = focusKey( e.target );
		schedule( 0 );
	} );
	document.addEventListener( 'focusout', () => {
		myFocus = '';
		schedule( 0 );
	} );

	// The block editor canvas is a same-origin iframe, so mouse events don't reach us.
	function hookCanvas() {
		const frame = canvasFrame();
		let doc;

		try {
			doc = frame && frame.contentDocument;
		} catch ( e ) {
			return;
		}

		if ( ! doc || ! doc.body || hookedDocs.has( doc ) ) {
			return;
		}

		hookedDocs.add( doc );

		const offset = () => surfaceBox( SURFACE_CANVAS );

		doc.addEventListener(
			'pointermove',
			( e ) => {
				const box = offset();
				lastSource = e.pointerType;
				record( SURFACE_CANVAS, e.clientX + box.left, e.clientY + box.top, kindOf( e.target ), 0, e.target );
			},
			{ passive: true }
		);
		doc.addEventListener(
			'pointerdown',
			( e ) => {
				const box = offset();
				lastSource = e.pointerType;
				record( SURFACE_CANVAS, e.clientX + box.left, e.clientY + box.top, kindOf( e.target ), EV_CLICK, e.target );
			},
			{ passive: true }
		);
		doc.addEventListener(
			'input',
			( e ) => {
				const box = offset();
				onType( e, SURFACE_CANVAS, box.left, box.top );
			},
			{ passive: true }
		);
		doc.defaultView.addEventListener(
			'scroll',
			() => {
				if ( followsScroll() && lastPointer.surface === SURFACE_CANVAS ) {
					const { clientX, clientY, kind } = lastPointer;
					record( SURFACE_CANVAS, clientX, clientY, kind, 0, elementAt( SURFACE_CANVAS, clientX, clientY ) );
				}
			},
			{ passive: true }
		);
	}

	if ( document.body.classList.contains( 'block-editor-page' ) ) {
		setInterval( hookCanvas, 1500 );
	}

	/* ---------- Talking to the server ---------- */

	function interval() {
		if ( failures ) {
			return Math.min( SLOW * Math.pow( 2, failures ), 30000 );
		}

		const now = Date.now();
		const iMove = sending() && watched && ( batch.length || now - lastMoveAt < 1500 );
		const theyMove = now < remoteActiveUntil;

		if ( iMove || theyMove ) {
			return FAST;
		}

		return watched || here.length ? STILL : SLOW;
	}

	// Never sooner than the current rate allows, measured from the last send.
	function schedule( ms ) {
		const wait = Math.max( ms, interval() - ( Date.now() - lastSentAt ) );
		const at = Date.now() + wait;

		if ( timer && timerAt <= at ) {
			return;
		}

		clearTimeout( timer );
		timerAt = at;
		timer = setTimeout( pulse, wait );
	}

	function request( path, body, keepalive ) {
		return window.fetch( cfg.root + path, {
			method: 'POST',
			credentials: 'same-origin',
			keepalive: !! keepalive,
			headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': nonce },
			body: JSON.stringify( body || {} ),
		} );
	}

	function pulse() {
		timer = null;

		if ( document.hidden ) {
			return;
		}

		// Two requests in flight at most; the next one goes out when one comes back.
		if ( inflight >= MAX_INFLIGHT ) {
			return;
		}

		if ( batch.length ) {
			seq = Math.max( Date.now(), seq + 1 );
			lastBatch = batch;
			lastAnchors = batchAnchors;
			batch = [];
			batchAnchors = [];
		}

		send();
		schedule( interval() );
	}

	async function send() {
		const id = ++requestCount;

		inflight++;
		lastSentAt = Date.now();

		try {
			const res = await request( 'pulse', {
				room,
				title: screenTitle(),
				seq,
				focus: sending() ? myFocus : '',
				idle: lastMoveAt ? Math.round( ( Date.now() - lastMoveAt ) / 1000 ) : IDLE_AFTER + 1,
				ghost,
				points: sending() ? lastBatch : [],
				anchors: sending() ? lastAnchors : [],
			} );

			// Expired nonce or lost role: I back off and let Heartbeat refresh the nonce.
			if ( res.status === 401 || res.status === 403 ) {
				failures = 5;
				clearPeers();
				return;
			}

			if ( ! res.ok ) {
				throw new Error( String( res.status ) );
			}

			const data = await res.json();
			failures = 0;

			// Two requests can overlap; an older answer must not undo a newer one.
			if ( id > appliedRequest ) {
				appliedRequest = id;
				render( data );
			}
		} catch ( e ) {
			failures = Math.min( failures + 1, 5 );
		} finally {
			inflight--;
			schedule( 0 );
		}
	}

	function leave() {
		request( 'leave', {}, true ).catch( () => {} );
	}

	document.addEventListener( 'visibilitychange', () => {
		if ( document.hidden ) {
			leave();
		} else {
			schedule( 0 );
		}
	} );
	window.addEventListener( 'pagehide', leave );

	// Heartbeat hands out a fresh REST nonce, so long sessions keep working.
	if ( window.jQuery ) {
		window.jQuery( document ).on( 'heartbeat-tick', ( e, data ) => {
			if ( data && data.rest_nonce ) {
				nonce = data.rest_nonce;
			}
		} );
	}

	/* ---------- Other people's cursors ---------- */

	function render( data ) {
		watched = !! data.watched;

		if ( ! canView ) {
			return;
		}

		const seen = new Set();

		here = Array.isArray( data.here ) ? data.here : [];
		elsewhere = Array.isArray( data.elsewhere ) ? data.elsewhere : [];

		here.forEach( ( person ) => {
			seen.add( person.id );
			updatePeer( person );
		} );

		peers.forEach( ( peer, id ) => {
			if ( ! seen.has( id ) ) {
				removePeer( id );
			}
		} );

		renderBar();

		if ( peers.size && ! rafId ) {
			rafId = window.requestAnimationFrame( tick );
		}
	}

	function clearPeers() {
		peers.forEach( ( peer, id ) => removePeer( id ) );
		here = [];
		elsewhere = [];
		watched = false;
		renderBar();
	}

	function svgIcon( name, viewBox, d ) {
		const ns = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS( ns, 'svg' );
		svg.setAttribute( 'class', 'lacu-cursor__icon lacu-cursor__icon--' + name );
		svg.setAttribute( 'viewBox', viewBox );
		const path = document.createElementNS( ns, 'path' );
		path.setAttribute( 'd', d );
		svg.appendChild( path );
		return svg;
	}

	function createCursor( person ) {
		const el = document.createElement( 'div' );
		el.className = 'lacu-cursor';
		el.style.setProperty( '--lacu-color', colorOf( person ) );

		el.appendChild( svgIcon( 'arrow', '0 0 18 22', 'M2 1.5v16.2l4.3-4.1 2.9 6.7 3-1.3-2.9-6.6h6.1z' ) );
		el.appendChild(
			svgIcon(
				'pointer',
				'0 0 20 24',
				'M7 2.6a1.6 1.6 0 0 1 3.2 0v7.1a1.5 1.5 0 0 1 2.9.3 1.5 1.5 0 0 1 2.9.4 1.5 1.5 0 0 1 2.8.7v5.4c0 3.6-2.4 6.5-6 6.5h-1.7c-2.1 0-3.6-.9-4.8-2.5L2.6 15a1.5 1.5 0 0 1 2.3-1.9L7 15.1z'
			)
		);
		el.appendChild(
			svgIcon(
				'text',
				'0 0 12 22',
				'M2 1h2.5c.7 0 1.2.3 1.5.8.3-.5.8-.8 1.5-.8H10v2H8v16h2v2H7.5c-.7 0-1.2-.3-1.5-.8-.3.5-.8.8-1.5.8H2v-2h2V3H2z'
			)
		);

		const label = document.createElement( 'span' );
		label.className = 'lacu-cursor__label';

		const arrow = document.createElement( 'span' );
		arrow.className = 'lacu-cursor__edge';
		label.appendChild( arrow );

		if ( person.avatar ) {
			const img = document.createElement( 'img' );
			img.className = 'lacu-cursor__avatar';
			img.src = person.avatar;
			img.alt = '';
			label.appendChild( img );
		}

		const name = document.createElement( 'span' );
		name.className = 'lacu-cursor__name';
		name.textContent = person.name;
		label.appendChild( name );

		const dots = document.createElement( 'span' );
		dots.className = 'lacu-cursor__dots';
		dots.append( document.createElement( 'i' ), document.createElement( 'i' ), document.createElement( 'i' ) );
		label.appendChild( dots );

		// When they're off-screen the tag is pinned to the edge; clicking it scrolls to them.
		label.addEventListener( 'click', () => jumpTo( person.id ) );

		el.append( label );
		layer.appendChild( el );

		return el;
	}

	function toPoint( raw, at, anchors ) {
		const flags = raw[ 3 ];
		const anchor = raw.length >= 7 && anchors[ raw[ 6 ] ] ? anchors[ raw[ 6 ] ] : '';
		return {
			x: raw[ 0 ],
			y: raw[ 1 ],
			anchor,
			rx: anchor ? raw[ 4 ] : 0,
			ry: anchor ? raw[ 5 ] : 0,
			s: flags % 4,
			kind: Math.floor( flags / 4 ) % 4,
			click: bit( flags, EV_CLICK ),
			type: bit( flags, EV_TYPE ),
			away: bit( flags, EV_AWAY ),
			at,
		};
	}

	function updatePeer( person ) {
		let peer = peers.get( person.id );
		const points = Array.isArray( person.points ) ? person.points : [];
		const anchors = Array.isArray( person.anchors ) ? person.anchors : [];

		if ( ! peer ) {
			if ( ! points.length ) {
				return;
			}

			// Newcomers just appear where they are, no replay.
			const last = toPoint( points[ points.length - 1 ], performance.now(), anchors );
			last.click = false;
			last.type = false;

			peer = {
				person,
				el: createCursor( person ),
				seq: person.seq,
				prev: last,
				queue: [],
				queueEnd: 0,
				typingUntil: 0,
				focusKey: '',
				focusEl: null,
				state: '',
			};
			peers.set( person.id, peer );
		} else if ( person.seq > peer.seq && points.length ) {
			enqueue( peer, points, anchors );
			peer.seq = person.seq;
			remoteActiveUntil = Date.now() + 1500;
		}

		peer.person = person;
		peer.el.classList.toggle( 'lacu-cursor--idle', person.idle > IDLE_AFTER );
		setFocus( peer, hideOthers ? '' : person.focus || '' );
	}

	// Replays what's queued faster so it ends inside the buffer window. Same path, less delay.
	function fastForward( queue, now ) {
		if ( ! queue.length ) {
			return;
		}

		const first = queue[ 0 ].at;
		const range = Math.max( 1, queue[ queue.length - 1 ].at - first );
		queue.forEach( ( point ) => {
			point.at = now + ( ( point.at - first ) / range ) * PLAYBACK_DELAY;
		} );
	}

	function enqueue( peer, points, anchors ) {
		const now = performance.now();
		let start = Math.max( now + PLAYBACK_DELAY, peer.queueEnd );

		// Network jitter keeps pushing playback later; I never let that build up.
		if ( start - now > MAX_LAG ) {
			fastForward( peer.queue, now );
			start = now + PLAYBACK_DELAY;
		}

		// Glide from where they were rather than jumping.
		if ( ! peer.queue.length ) {
			peer.prev = Object.assign( {}, peer.prev, { at: now, click: false, type: false } );
		}

		// A long batch means their sends stalled, so I squeeze it too.
		const span = points[ points.length - 1 ][ 2 ];
		const scale = span > MAX_BATCH_SPAN ? MAX_BATCH_SPAN / span : 1;

		points.forEach( ( raw ) => peer.queue.push( toPoint( raw, start + raw[ 2 ] * scale, anchors ) ) );
		peer.queueEnd = start + span * scale + SAMPLE;
	}

	function removePeer( id ) {
		const peer = peers.get( id );
		if ( peer ) {
			setFocus( peer, '' );
			peer.el.remove();
			peers.delete( id );
		}
	}

	function findField( key ) {
		try {
			if ( key.indexOf( 'name:' ) === 0 ) {
				return document.querySelector( '[name="' + window.CSS.escape( key.slice( 5 ) ) + '"]' );
			}
			return document.getElementById( key );
		} catch ( e ) {
			return null;
		}
	}

	function setFocus( peer, key ) {
		if ( key === peer.focusKey ) {
			return;
		}

		if ( peer.focusEl ) {
			peer.focusEl.classList.remove( 'lacu-focus', 'lacu-focus--key' );
			peer.focusEl.style.removeProperty( '--lacu-color' );
		}

		peer.focusKey = key;
		peer.focusEl = key ? findField( key ) : null;

		if ( peer.focusEl ) {
			peer.focusEl.style.setProperty( '--lacu-color', colorOf( peer.person ) );
			peer.focusEl.classList.add( 'lacu-focus' );
		}
	}

	// Removes and re-adds a class so its animation plays again.
	function replay( el, className, ms ) {
		el.classList.remove( className );
		void el.offsetWidth;
		el.classList.add( className );
		clearTimeout( el[ 'lacuTimer' + className ] );
		el[ 'lacuTimer' + className ] = setTimeout( () => el.classList.remove( className ), ms );
	}

	function burst( left, top, color ) {
		const fx = document.createElement( 'span' );
		fx.className = 'lacu-burst';
		fx.style.setProperty( '--lacu-color', color );
		fx.style.transform = 'translate3d(' + left + 'px,' + top + 'px,0)';

		for ( let i = 0; i < 8; i++ ) {
			const spark = document.createElement( 'i' );
			spark.style.setProperty( '--lacu-angle', i * 45 + 'deg' );
			fx.appendChild( spark );
		}

		layer.appendChild( fx );
		setTimeout( () => fx.remove(), 700 );
	}

	// Finds the same element on my screen. A miss is remembered for a second so I don't retry every frame.
	function resolveAnchor( anchor, surface ) {
		const key = surface + '|' + anchor;
		const now = performance.now();
		const cached = anchorCache.get( key );

		if ( cached && ( cached.el ? cached.el.isConnected : now - cached.at < 1000 ) ) {
			return cached.el;
		}

		const doc = surface === SURFACE_CANVAS ? canvasDoc() : document;
		const parts = anchor.split( '|' );
		let el = doc ? doc.getElementById( parts[ 0 ] ) : null;

		( parts[ 1 ] ? parts[ 1 ].split( '/' ) : [] ).some( ( step ) => {
			const child = el ? el.children[ parseInt( step, 10 ) ] : null;
			el = child && child.tagName.toLowerCase() === step.replace( /^\d+/, '' ) ? child : null;
			return ! el;
		} );

		if ( anchorCache.size > 500 ) {
			anchorCache.clear();
		}

		anchorCache.set( key, { el, at: now } );
		return el;
	}

	// Their spot on my screen: inside the same element if I have it, raw coordinates if not.
	function toScreen( point, boxes ) {
		const box = boxes[ point.s ] || ( boxes[ point.s ] = surfaceBox( point.s ) );
		const el = point.anchor ? resolveAnchor( point.anchor, point.s ) : null;
		const r = el ? rectOf( el, point.s, box ) : null;

		if ( r && ( r.width || r.height ) ) {
			return { left: r.left + point.rx * r.width, top: r.top + point.ry * r.height, box };
		}

		return { left: box.left + point.x * box.width, top: box.top + point.y - box.scroll, box };
	}

	function edgeOf( pos ) {
		if ( pos.top < pos.box.top - 4 ) {
			return 'up';
		}
		return pos.top > pos.box.top + pos.box.height ? 'down' : '';
	}

	function consume( peer, point, now, boxes ) {
		peer.prev = point;

		if ( point.type ) {
			peer.typingUntil = now + TYPING_FOR;
			replay( peer.el, 'lacu-cursor--key', 180 );
			if ( peer.focusEl ) {
				replay( peer.focusEl, 'lacu-focus--key', 300 );
			}
		}

		if ( point.click && ! hideOthers ) {
			const hit = toScreen( point, boxes );
			if ( ! edgeOf( hit ) ) {
				burst( hit.left, hit.top, colorOf( peer.person ) );
				replay( peer.el, 'lacu-cursor--click', 220 );
			}
		}
	}

	function paint( peer, now, boxes ) {
		while ( peer.queue.length && peer.queue[ 0 ].at <= now ) {
			consume( peer, peer.queue.shift(), now, boxes );
		}

		const point = peer.prev;
		const next = peer.queue[ 0 ];
		const pos = toScreen( point, boxes );

		// I blend on screen, since the two points may be anchored to different elements.
		if ( next && next.s === point.s && next.at > point.at ) {
			const t = clamp( ( now - point.at ) / ( next.at - point.at ), 0, 1 );
			const to = toScreen( next, boxes );
			pos.left += ( to.left - pos.left ) * t;
			pos.top += ( to.top - pos.top ) * t;
		}

		pos.edge = edgeOf( pos );
		const typing = now < peer.typingUntil;
		const kind = typing ? KIND_TEXT : point.kind;

		// Off-screen: pin the name tag to the top or bottom edge, pointing at them.
		let left = pos.left;
		let top = pos.top;

		if ( pos.edge ) {
			const bar = document.getElementById( 'wpadminbar' );
			const minTop = ( bar ? bar.offsetHeight : 0 ) + 10;
			left = clamp( left, 12, window.innerWidth - 180 );
			top = pos.edge === 'up' ? minTop : window.innerHeight - 36;
		}

		const state = [ kind, typing, point.away, pos.edge ].join( '|' );
		if ( state !== peer.state ) {
			peer.state = state;
			const cl = peer.el.classList;
			KIND_CLASSES.forEach( ( c, k ) => c && cl.toggle( c, k === kind ) );
			cl.toggle( 'lacu-cursor--typing', typing );
			cl.toggle( 'lacu-cursor--away', !! point.away );
			cl.toggle( 'lacu-cursor--edge', !! pos.edge );
			cl.toggle( 'lacu-cursor--edge-up', pos.edge === 'up' );
			cl.toggle( 'lacu-cursor--edge-down', pos.edge === 'down' );
		}

		peer.el.style.transform = 'translate3d(' + left.toFixed( 1 ) + 'px,' + top.toFixed( 1 ) + 'px,0)';
	}

	function tick( now ) {
		rafId = 0;

		if ( ! peers.size ) {
			return;
		}

		const boxes = {};
		peers.forEach( ( peer ) => paint( peer, now, boxes ) );

		rafId = window.requestAnimationFrame( tick );
	}

	function jumpTo( id ) {
		const peer = peers.get( id );
		if ( ! peer ) {
			return;
		}

		const pos = toScreen( peer.prev, {} );
		pos.box.scroller.scrollBy( { top: pos.top - ( pos.box.top + pos.box.height / 2 ), behavior: 'smooth' } );
		replay( peer.el, 'lacu-cursor--ping', 1600 );
	}

	/* ---------- Toolbar (viewers only) ---------- */

	const barNode = canView ? document.getElementById( 'wp-admin-bar-lacu-presence' ) : null;

	function avatarImg( person, className ) {
		const img = document.createElement( 'img' );
		img.className = className;
		img.src = person.avatar;
		img.alt = '';
		img.style.setProperty( '--lacu-color', colorOf( person ) );
		return img;
	}

	function barItem( text, opts ) {
		const li = document.createElement( 'li' );
		const item = document.createElement( opts.href || opts.onClick ? 'a' : 'div' );
		item.className = 'ab-item' + ( opts.onClick || opts.href ? '' : ' ab-empty-item' );

		if ( opts.className ) {
			li.className = opts.className;
		}

		if ( opts.person ) {
			item.appendChild( avatarImg( opts.person, 'lacu-bar__avatar' ) );
		}

		const name = document.createElement( 'span' );
		name.className = 'lacu-bar__name';
		name.textContent = text;
		item.appendChild( name );

		if ( opts.meta ) {
			const meta = document.createElement( 'span' );
			meta.className = 'lacu-bar__meta';
			meta.textContent = opts.meta;
			item.appendChild( meta );
		}

		if ( opts.href ) {
			item.href = opts.href;
		} else if ( opts.onClick ) {
			item.href = '#';
			item.setAttribute( 'role', 'button' );
			item.addEventListener( 'click', ( e ) => {
				e.preventDefault();
				opts.onClick();
			} );
		}

		li.appendChild( item );
		return li;
	}

	function renderBar() {
		if ( ! barNode ) {
			return;
		}

		const signature = JSON.stringify( [
			ghost,
			hideOthers,
			here.map( ( p ) => [ p.id, p.name, p.avatar, p.color, p.idle > IDLE_AFTER ] ),
			elsewhere.map( ( p ) => [ p.id, p.name, p.avatar, p.color, p.room, p.title ] ),
		] );

		if ( signature === barSignature ) {
			return;
		}

		barSignature = signature;

		const total = here.length + elsewhere.length;
		barNode.classList.toggle( 'lacu-bar--alone', ! total );
		barNode.classList.toggle( 'lacu-bar--ghost', ghost );

		const faces = barNode.querySelector( '.lacu-bar__faces' );
		const count = barNode.querySelector( '.lacu-bar__count' );

		if ( faces ) {
			faces.replaceChildren( ...here.slice( 0, 3 ).map( ( p ) => avatarImg( p, 'lacu-bar__face' ) ) );
		}

		if ( count ) {
			count.textContent = String( total );
		}

		const list = barNode.querySelector( '.ab-submenu' );
		if ( ! list ) {
			return;
		}

		const items = [];

		if ( ! total ) {
			items.push( barItem( i18n.alone, {} ) );
		}

		if ( here.length ) {
			items.push( barItem( i18n.here, { className: 'lacu-bar__heading' } ) );
			here.forEach( ( p ) =>
				items.push(
					barItem( p.name, {
						person: p,
						meta: p.idle > IDLE_AFTER ? i18n.idle : '',
						onClick: () => jumpTo( p.id ),
					} )
				)
			);
		}

		if ( elsewhere.length ) {
			items.push( barItem( i18n.elsewhere, { className: 'lacu-bar__heading' } ) );
			elsewhere.forEach( ( p ) =>
				items.push( barItem( p.name, { person: p, meta: p.title, href: cfg.adminUrl + p.room } ) )
			);
		}

		// Hiding my own cursor only means something if my role has one.
		if ( canSend ) {
			items.push(
				barItem( ghost ? i18n.showMe : i18n.hideMe, {
					className: 'lacu-bar__toggle',
					onClick: () => {
						ghost = ! ghost;
						writePref( 'ghost', ghost );
						barSignature = '';
						renderBar();
						schedule( 0 );
					},
				} )
			);
		}

		items.push(
			barItem( hideOthers ? i18n.showOthers : i18n.hideOthers, {
				className: 'lacu-bar__toggle',
				onClick: () => {
					hideOthers = ! hideOthers;
					writePref( 'hideOthers', hideOthers );
					layer.hidden = hideOthers;
					peers.forEach( ( peer ) => setFocus( peer, hideOthers ? '' : peer.person.focus || '' ) );
					barSignature = '';
					renderBar();
				},
			} )
		);

		list.replaceChildren( ...items );
	}

	if ( barNode ) {
		const top = barNode.querySelector( ':scope > .ab-item' );
		if ( top ) {
			top.addEventListener( 'click', ( e ) => e.preventDefault() );
		}
	}

	schedule( 0 );
} )();
