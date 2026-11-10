pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const CLAVE_PREFS = 'firmadorActas.v3';
const CLAVE_PREFS_V2 = 'firmadorActas.v2';
const PX_POR_PUNTO_100 = 96 / 72; // zoom 100% = tamaño real de la hoja en pantalla
const MARGEN_ANCHO = 48;          // padding horizontal del visor (24 + 24)
const MARGEN_ALTO = 60 + 22 + 20; // barra de zoom + espacio del rótulo de página + aire abajo

// Coordenadas en puntos PDF, origen abajo-izquierda (las mismas que usa pdf-lib).
// Medidas sobre actas reales de 595x842. "anclaY" es la línea base del texto "Firmas..."
// en esas actas: si en otro PDF aparece más arriba o más abajo, los lugares se corren igual.
const TIPOS = {
	mesa: {
		nombre: 'Acta de examen (mesa)',
		titulo: /ACTADEEXAMEN/,      // el sistema viejo dice "ACTA de EXAMEN": no entra
		anclaY: 114.7,
		lugares: [
			{ x: 60,  y: 84, w: 130, h: 55 },
			{ x: 226, y: 84, w: 130, h: 55 },
			{ x: 415, y: 86, w: 130, h: 55 }
		]
	},
	promo: {
		nombre: 'Acta de promoción',
		titulo: /DEPROMOCI/,         // también "ACTA RECTIFICATIVA DE PROMOCIÓN"
		anclaY: 92.4,
		lugares: [
			{ x: 115, y: 40, w: 130, h: 65 },
			{ x: 255, y: 40, w: 130, h: 65 },
			{ x: 395, y: 40, w: 130, h: 65 }
		]
	}
};
const ANCLA = /^Firmas\b/;

let ultimoId = 0;
const limitar = (v, min, max) => Math.min(Math.max(v, min), max);
const redondear = v => Math.round(v * 10) / 10;
const clonar = v => JSON.parse(JSON.stringify(v));
const mismoEstado = (a, b) =>
	JSON.stringify({ l: a.lugares, m: a.modoPagina }) === JSON.stringify({ l: b.lugares, m: b.modoPagina });

// ---------- Preferencias (localStorage) ----------
// { guardarFirmas, zoom, ultima: { tipo: estado }, seleccion: { tipo: idConfig }, configs: [{ id, nombre, tipo, ...estado }] }
// estado = { lugares: [{ x, y, w, h, firmaId }], modoPagina }
const esObjeto = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const estadoValido = e => esObjeto(e) && Array.isArray(e.lugares) &&
	e.lugares.every(l => esObjeto(l) && [l.x, l.y, l.w, l.h].every(Number.isFinite));

// Lo guardado puede venir viejo o tocado a mano: lo que no tiene la forma esperada se descarta
function limpiarPrefs(p, base) {
	base.guardarFirmas = p.guardarFirmas === true;
	if (p.zoom === 'ancho' || p.zoom === 'alto' || (Number.isFinite(p.zoom) && p.zoom > 0)) base.zoom = p.zoom;
	if (esObjeto(p.ultima)) {
		for (const [t, e] of Object.entries(p.ultima)) if (estadoValido(e)) base.ultima[t] = e;
	}
	if (esObjeto(p.seleccion)) {
		for (const [t, id] of Object.entries(p.seleccion)) if (typeof id === 'string') base.seleccion[t] = id;
	}
	if (Array.isArray(p.configs)) {
		base.configs = p.configs.filter(c => estadoValido(c) && typeof c.id === 'string' && typeof c.nombre === 'string' && typeof c.tipo === 'string');
	}
	return base;
}

function leerPrefs() {
	const base = { guardarFirmas: false, zoom: 'ancho', ultima: {}, seleccion: {}, configs: [] };
	try {
		const p = JSON.parse(localStorage.getItem(CLAVE_PREFS));
		if (esObjeto(p)) return limpiarPrefs(p, base);
		// versión anterior: solo posiciones por tipo de acta
		const v2 = JSON.parse(localStorage.getItem(CLAVE_PREFS_V2));
		if (esObjeto(v2) && esObjeto(v2.lugares)) {
			for (const [t, ls] of Object.entries(v2.lugares)) {
				const e = { lugares: Array.isArray(ls) ? ls.map(l => ({ ...l, firmaId: null })) : null, modoPagina: v2.modoPagina || 'todas' };
				if (estadoValido(e)) base.ultima[t] = e;
			}
		}
	} catch (e) {}
	return base;
}

// ---------- Firmas guardadas (IndexedDB: las imágenes no entran cómodas en localStorage) ----------
const BD_NOMBRE = 'firmadorActas', BD_TABLA = 'firmas';
function abrirBD() {
	return new Promise((ok, mal) => {
		const r = indexedDB.open(BD_NOMBRE, 1);
		r.onupgradeneeded = () => r.result.createObjectStore(BD_TABLA, { keyPath: 'id' });
		r.onsuccess = () => ok(r.result);
		r.onerror = () => mal(r.error);
	});
}
async function enBD(modo, operacion) {
	const db = await abrirBD();
	return new Promise((ok, mal) => {
		const tx = db.transaction(BD_TABLA, modo);
		const pedido = operacion(tx.objectStore(BD_TABLA));
		tx.oncomplete = () => { db.close(); ok(pedido.result); };
		tx.onerror = tx.onabort = () => { db.close(); mal(tx.error); };
	});
}
const FirmasBD = {
	todas: () => enBD('readonly', t => t.getAll()),
	guardar: registro => enBD('readwrite', t => t.put(registro)),
	borrar: id => enBD('readwrite', t => t.delete(id)),
	borrarTodas: () => enBD('readwrite', t => t.clear())
};

// Identificador por contenido: la misma imagen cargada dos veces se guarda una sola vez
async function huella(bytes) {
	try {
		const h = await crypto.subtle.digest('SHA-256', bytes);
		return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
	} catch (e) {
		// sin crypto.subtle (http que no es localhost): FNV-1a, alcanza para reconocer la misma imagen
		let a = 0x811c9dc5, b = 0x01000193;
		for (const x of new Uint8Array(bytes)) {
			a = Math.imul(a ^ x, 0x01000193) >>> 0;
			b = Math.imul(b ^ x, 0x811c9dc5) >>> 0;
		}
		return 'f' + a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0') + bytes.byteLength.toString(16);
	}
}

Vue.createApp({
	data() {
		const prefs = leerPrefs();
		return {
			prefs,
			biblioteca: [],       // firmas guardadas: [{ id, nombre, tipo, bytes, url }]
			pdfFile: null,
			pdfBytes: null,
			paginas: [],          // [{ num, ancho, alto }] en puntos PDF
			tipo: null,           // 'mesa' | 'promo' | null
			desplazamiento: 0,    // cuánto se corrió el pie respecto de las actas de referencia
			avisoPie: '',
			lugares: [],          // [{ id, x, y, w, h, firma, sobre }]; firma = { id|null, nombre, tipo, bytes, url }
			modoPagina: 'todas',  // 'todas' | 'ultima' | número de página (1..n)
			zoom: prefs.zoom,     // 'ancho' | 'alto' | factor (1 = 100%)
			anchoVisor: 0,
			altoVisor: 0,
			resaltado: null,      // id del lugar bajo el mouse (en el PDF o en la lista)
			sobreZonaPdf: false,
			cargando: false,
			toasts: [],
			preview: null,        // { url, blob }
			eligiendo: null,      // lugar para el que se elige una firma guardada
			verDatos: false,
			confirmar: null,      // 'desactivar' | 'todo'
			nombreNuevo: null,    // texto del "Guardar como…" mientras está abierto
			reemplazo: null       // id de la configuración que se pisaría, esperando confirmación
		};
	},
	computed: {
		nombreTipo() {
			return this.tipo ? TIPOS[this.tipo].nombre : '';
		},
		claveTipo() {
			return this.tipo || 'otro';
		},
		firmasCargadas() {
			return this.lugares.filter(l => l.firma).length;
		},
		paginasAFirmar() {
			const n = this.paginas.length;
			if (this.modoPagina === 'todas') return this.paginas.map(p => p.num);
			if (this.modoPagina === 'ultima') return n ? [n] : [];
			return [this.modoPagina];
		},
		pxPorPunto() {
			if (this.zoom === 'ancho') {
				const ancho = Math.max(...this.paginas.map(p => p.ancho), 1);
				return Math.max((this.anchoVisor - MARGEN_ANCHO) / ancho, 0.2);
			}
			if (this.zoom === 'alto') {
				const alto = Math.max(...this.paginas.map(p => p.alto), 1);
				return Math.max((this.altoVisor - MARGEN_ALTO) / alto, 0.2);
			}
			return this.zoom * PX_POR_PUNTO_100;
		},
		zoomPorcentaje() {
			return Math.round(this.pxPorPunto / PX_POR_PUNTO_100 * 100);
		},
		// Lo que se guarda como "última usada" o en una configuración con nombre
		instantanea() {
			const d = this.desplazamiento;
			return {
				lugares: this.lugares.map(l => ({
					x: redondear(l.x), y: redondear(l.y - d), w: redondear(l.w), h: redondear(l.h),
					firmaId: (l.firma && l.firma.id) || null
				})),
				modoPagina: this.modoPagina
			};
		},
		configsDelTipo() {
			return this.prefs.configs.filter(c => c.tipo === this.claveTipo);
		},
		seleccionId() {
			const id = this.prefs.seleccion[this.claveTipo];
			return this.configsDelTipo.some(c => c.id === id) ? id : '';
		},
		configSeleccionada() {
			return this.configsDelTipo.find(c => c.id === this.seleccionId) || null;
		},
		configModificada() {
			return !!this.configSeleccionada && !mismoEstado(this.configSeleccionada, this.instantanea);
		}
	},
	watch: {
		pxPorPunto() {
			// Re-render nítido para el nuevo tamaño, esperando a que termine el cambio
			clearTimeout(this.timerRender);
			this.timerRender = setTimeout(() => this.dibujarPaginas(), 150);
		},
		zoom(valor) {
			this.prefs.zoom = valor;
			this.guardarPrefs();
		},
		modoPagina() {
			this.persistir();
		}
	},
	created() {
		// Estado no reactivo (pdf.js no se lleva bien con los proxies de Vue)
		this.pdfDoc = null;
		this.canvases = {};
		this.tareas = {};
		this.cola = Promise.resolve();
		this.ocupado = false;
		this.bibliotecaLista = this.cargarBiblioteca();
	},
	mounted() {
		// Si se suelta un archivo fuera de un recuadro: un PDF se abre como acta; lo demás se ignora
		window.addEventListener('dragover', e => e.preventDefault());
		window.addEventListener('drop', e => {
			e.preventDefault();
			const f = e.dataTransfer.files[0];
			if (f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name))) this.abrirPDF(f);
		});
		window.addEventListener('keydown', e => {
			if (e.key !== 'Escape') return;
			if (this.eligiendo) this.eligiendo = null;
			else if (this.verDatos) this.cerrarDatos();
			else this.cerrarPreview();
		});
		window.addEventListener('storage', this.alCambiarEnOtraPestana);
		const visor = this.$refs.visor;
		new ResizeObserver(() => {
			this.anchoVisor = visor.clientWidth;
			this.altoVisor = visor.clientHeight;
		}).observe(visor);
	},
	methods: {
		// ---------- Avisos ----------

		avisar(mensaje, tipo = 'ok') {
			const id = ++ultimoId;
			this.toasts.push({ id, mensaje, tipo });
			setTimeout(() => this.cerrarToast(id), 4500);
		},

		cerrarToast(id) {
			this.toasts = this.toasts.filter(t => t.id !== id);
		},

		// ---------- Guardado ----------

		guardarPrefs() {
			try {
				localStorage.setItem(CLAVE_PREFS, JSON.stringify(this.prefs));
			} catch (e) {
				if (!this.avisoSinGuardar) this.avisar('Este navegador no deja guardar la configuración', 'aviso');
				this.avisoSinGuardar = true;
			}
		},

		// Guarda el estado actual como "última usada" de este tipo de acta
		persistir() {
			if (!this.paginas.length) return;
			this.prefs.ultima[this.claveTipo] = clonar(this.instantanea);
			this.guardarPrefs();
		},

		// Las operaciones sobre las firmas guardadas van de a una, en orden: así un "borrar"
		// no se cruza con un "guardar" que estaba a mitad de camino.
		enCola(operacion) {
			const resultado = this.cola.then(operacion);
			this.cola = resultado.catch(() => {});
			return resultado;
		},

		// Con "Recordar" activo trae las firmas guardadas; si está apagado, borra cualquier resto
		// (por ejemplo, de un borrado que falló), para que nunca queden firmas que no se ven.
		cargarBiblioteca() {
			return this.enCola(async () => {
				if (!this.prefs.guardarFirmas) {
					try { await FirmasBD.borrarTodas(); } catch (e) { console.error(e); }
					return;
				}
				try {
					const registros = (await FirmasBD.todas()).sort((a, b) => a.creada - b.creada);
					this.biblioteca = await Promise.all(registros.map(async r => ({
						id: r.id, nombre: r.nombre, tipo: r.tipo, bytes: await r.blob.arrayBuffer(), url: URL.createObjectURL(r.blob)
					})));
				} catch (e) {
					console.error(e);
					this.avisar('No pude leer las firmas guardadas', 'aviso');
				}
			});
		},

		// Guarda la firma (si ya estaba, devuelve la existente). Si "Recordar" está apagado
		// cuando le toca el turno, no guarda nada. Si el navegador no deja guardar, tira error.
		guardarEnBiblioteca(firma) {
			return this.enCola(async () => {
				if (!this.prefs.guardarFirmas || firma.id) return firma;
				const id = await huella(firma.bytes);
				const existente = this.biblioteca.find(f => f.id === id);
				if (existente) return existente;
				await FirmasBD.guardar({
					id, nombre: firma.nombre, tipo: firma.tipo, creada: Date.now(),
					blob: new Blob([firma.bytes], { type: firma.tipo })
				});
				firma.id = id;
				this.biblioteca.push(firma);
				return this.biblioteca[this.biblioteca.length - 1];
			});
		},

		// Reemplaza una firma por otra en todos los lugares que la usan
		reemplazarFirma(vieja, nueva) {
			if (vieja === nueva) return;
			for (const l of this.lugares) if (l.firma === vieja) l.firma = nueva;
			if (!this.firmaEnUso(vieja)) this.soltarUrl(vieja);
		},

		// Saca referencias a firmas que ya no están guardadas (todas si ids es null)
		olvidarIdsDeFirmas(ids) {
			const estados = [...Object.values(this.prefs.ultima), ...this.prefs.configs];
			for (const e of estados) {
				for (const l of e.lugares) if (l.firmaId && (!ids || ids.has(l.firmaId))) l.firmaId = null;
			}
		},

		async activarGuardado() {
			if (this.ocupado) return;
			this.ocupado = true;
			this.prefs.guardarFirmas = true;
			this.confirmar = null;
			this.guardarPrefs();
			let fallo = false;
			for (const f of new Set(this.lugares.map(l => l.firma).filter(f => f && !f.id))) {
				try {
					this.reemplazarFirma(f, await this.guardarEnBiblioteca(f));
				} catch (e) {
					console.error(e);
					fallo = true;
					break;
				}
			}
			this.ocupado = false;
			if (fallo && !this.biblioteca.length) {
				this.prefs.guardarFirmas = false;
				this.guardarPrefs();
				this.avisar('Este navegador no deja guardar las firmas', 'error');
				return;
			}
			this.persistir();
			this.avisar(fallo ? 'Algunas firmas no se pudieron guardar' : 'Listo: tus firmas quedan guardadas en este navegador', fallo ? 'aviso' : 'ok');
		},

		// Saca las firmas de la biblioteca en memoria: las que están en uso quedan cargadas en esta sesión
		// pero ya no figuran como guardadas.
		vaciarBiblioteca(ids) {
			for (const f of this.biblioteca) {
				if (ids && !ids.has(f.id)) continue;
				f.id = null;
				if (!this.firmaEnUso(f)) URL.revokeObjectURL(f.url);
			}
			this.biblioteca = ids ? this.biblioteca.filter(f => f.id) : [];
		},

		async desactivarGuardado() {
			if (this.ocupado) return;
			this.ocupado = true;
			this.prefs.guardarFirmas = false; // las cargas que estén en la cola ya no guardan
			this.confirmar = null;
			try {
				await this.enCola(() => FirmasBD.borrarTodas());
			} catch (e) {
				console.error(e);
				this.avisar('No pude borrar las firmas guardadas. Se van a borrar la próxima vez que abras la página.', 'error');
			}
			this.vaciarBiblioteca(null);
			this.olvidarIdsDeFirmas(null);
			this.guardarPrefs();
			this.persistir();
			this.ocupado = false;
			this.avisar('Se borraron las firmas guardadas', 'ok');
		},

		cambiarGuardado(e) {
			if (this.ocupado) {
				e.target.checked = this.prefs.guardarFirmas;
			} else if (e.target.checked) {
				this.activarGuardado();
			} else if (this.biblioteca.length) {
				e.target.checked = true; // se desactiva recién al confirmar
				this.confirmar = 'desactivar';
			} else {
				this.desactivarGuardado();
			}
		},

		async borrarFirmaGuardada(f) {
			const id = f.id;
			try {
				await this.enCola(() => FirmasBD.borrar(id));
			} catch (e) {
				console.error(e);
				this.avisar('No pude borrar la firma', 'error');
				return;
			}
			this.olvidarIdsDeFirmas(new Set([id]));
			this.vaciarBiblioteca(new Set([id]));
			this.guardarPrefs();
			this.persistir();
		},

		async borrarTodo() {
			this.prefs.guardarFirmas = false;
			let ok = true;
			try {
				await this.enCola(() => FirmasBD.borrarTodas());
			} catch (e) {
				console.error(e);
				ok = false;
			}
			this.vaciarBiblioteca(null);
			try {
				localStorage.removeItem(CLAVE_PREFS);
				localStorage.removeItem(CLAVE_PREFS_V2);
			} catch (e) {}
			const zoom = this.prefs.zoom;
			this.prefs = leerPrefs();
			this.prefs.zoom = zoom;
			this.confirmar = null;
			if (ok) this.avisar('Se borró todo lo guardado', 'ok');
			else this.avisar('Se borraron las configuraciones, pero no las firmas. Se van a borrar la próxima vez que abras la página.', 'error');
		},

		// Otra pestaña cambió lo guardado: se toma eso como verdad, para no pisarlo después
		alCambiarEnOtraPestana(e) {
			if (e.key !== CLAVE_PREFS && e.key !== null) return;
			const antes = this.prefs.guardarFirmas;
			this.prefs = leerPrefs();
			if (antes && !this.prefs.guardarFirmas) {
				this.vaciarBiblioteca(null);
			} else if (!antes && this.prefs.guardarFirmas) {
				this.bibliotecaLista = this.cargarBiblioteca();
			}
		},

		olvidarUltima(t) {
			delete this.prefs.ultima[t];
			this.guardarPrefs();
		},

		abrirDatos() {
			this.confirmar = null;
			this.verDatos = true;
		},

		cerrarDatos() {
			this.confirmar = null;
			this.verDatos = false;
		},

		nombreDeTipo(t) {
			return TIPOS[t] ? TIPOS[t].nombre : 'Otros documentos';
		},

		resumen(estado) {
			const n = estado.lugares.length;
			const conFirma = estado.lugares.filter(l => l.firmaId).length;
			return `${n} ${n === 1 ? 'lugar' : 'lugares'}` + (conFirma ? `, ${conFirma} con firma` : '');
		},

		// ---------- Configuraciones con nombre ----------

		empezarGuardarComo() {
			this.reemplazo = null;
			this.nombreNuevo = this.configSeleccionada ? this.configSeleccionada.nombre : '';
			this.$nextTick(() => this.$refs.inputNombre && this.$refs.inputNombre.select());
		},

		guardarComo() {
			const nombre = (this.nombreNuevo || '').trim();
			if (!nombre) return;
			const t = this.claveTipo;
			let config = this.prefs.configs.find(c => c.tipo === t && c.nombre.toLowerCase() === nombre.toLowerCase());
			// pisar otra configuración (no la que está elegida) pide confirmar con un segundo click
			if (config && config.id !== this.seleccionId && this.reemplazo !== config.id) {
				this.reemplazo = config.id;
				return;
			}
			this.reemplazo = null;
			if (!config) {
				config = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), nombre, tipo: t };
				this.prefs.configs.push(config);
			}
			Object.assign(config, clonar(this.instantanea), { nombre });
			this.prefs.seleccion[t] = config.id;
			this.nombreNuevo = null;
			this.guardarPrefs();
			this.avisar(`Configuración «${nombre}» guardada`, 'ok');
		},

		elegirConfig(id) {
			const t = this.claveTipo;
			if (!id) {
				delete this.prefs.seleccion[t];
				this.guardarPrefs();
				return;
			}
			const config = this.prefs.configs.find(c => c.id === id);
			if (!config) return;
			this.prefs.seleccion[t] = id;
			// la configuración trae sus lugares y sus firmas guardadas; lo que no tenga queda vacío
			this.aplicarEstado(config, false);
			this.persistir();
		},

		actualizarConfig() {
			const config = this.configSeleccionada;
			if (!config) return;
			Object.assign(config, clonar(this.instantanea));
			this.guardarPrefs();
			this.avisar(`Configuración «${config.nombre}» actualizada`, 'ok');
		},

		borrarConfig(config) {
			this.prefs.configs = this.prefs.configs.filter(c => c.id !== config.id);
			for (const t of Object.keys(this.prefs.seleccion)) {
				if (this.prefs.seleccion[t] === config.id) delete this.prefs.seleccion[t];
			}
			this.guardarPrefs();
		},

		// ---------- PDF ----------

		async abrirPDF(file) {
			if (!file) return;
			this.$refs.inputPdf.value = '';
			const carga = this.cargaActual = {};
			this.cargando = true;
			try {
				const bytes = await file.arrayBuffer();
				// pdf.js se queda con el buffer que recibe: le pasamos una copia
				const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
				const paginas = [];
				for (let n = 1; n <= doc.numPages; n++) {
					const vp = (await doc.getPage(n)).getViewport({ scale: 1 });
					paginas.push({ num: n, ancho: vp.width, alto: vp.height });
				}
				const { tipo, anclaY } = await this.detectarTipo(await doc.getPage(1));
				await this.bibliotecaLista;
				if (carga !== this.cargaActual) return;

				if (this.pdfDoc) this.pdfDoc.destroy();
				this.pdfDoc = doc;
				this.canvases = {};
				this.tareas = {};
				this.pdfFile = file;
				this.pdfBytes = bytes;
				this.paginas = paginas;
				this.tipo = tipo;
				this.desplazamiento = tipo && anclaY !== null ? anclaY - TIPOS[tipo].anclaY : 0;
				this.avisoPie = tipo && anclaY === null
					? 'No encontré el texto "Firmas" en el pie: revisá que los recuadros estén en su lugar.'
					: '';
				this.aplicarEstado(this.prefs.ultima[this.claveTipo] || this.estadoDeFabrica(), true);
				this.persistir();
				this.nombreNuevo = null;
				this.cerrarPreview();

				await this.$nextTick();
				const visor = this.$refs.visor;
				visor.scrollTop = 0;
				this.anchoVisor = visor.clientWidth;
				this.altoVisor = visor.clientHeight;
				await this.$nextTick();
				await this.dibujarPaginas();
			} catch (e) {
				console.error(e);
				this.avisar('No pude abrir el PDF: ' + e.message, 'error');
			} finally {
				if (carga === this.cargaActual) this.cargando = false;
			}
		},

		async detectarTipo(pagina) {
			const contenido = await pagina.getTextContent();
			// pdf.js a veces parte palabras ("ACTA DE PROMOCIÓ" + "N"): se compara sin espacios
			const texto = contenido.items.map(i => i.str).join('').replace(/\s+/g, '');
			const tipo = Object.keys(TIPOS).find(k => TIPOS[k].titulo.test(texto)) || null;
			const ancla = contenido.items.find(i => ANCLA.test(i.str.trim()));
			return { tipo, anclaY: ancla ? ancla.transform[5] : null };
		},

		registrarCanvas(num, el) {
			if (el) this.canvases[num] = el;
			else delete this.canvases[num];
		},

		async dibujarPaginas() {
			if (!this.pdfDoc) return;
			const doc = this.pdfDoc;
			for (const pag of this.paginas) {
				if (doc !== this.pdfDoc) return;
				await this.dibujarPagina(doc, pag);
			}
		},

		// Dibuja en un canvas aparte y recién al final lo copia, para que no parpadee al hacer zoom
		async dibujarPagina(doc, pag) {
			const anterior = this.tareas[pag.num];
			if (anterior) anterior.cancel();
			const escala = Math.min(this.pxPorPunto * (window.devicePixelRatio || 1), 6);
			const pagina = await doc.getPage(pag.num);
			const viewport = pagina.getViewport({ scale: escala });
			const temporal = document.createElement('canvas');
			temporal.width = Math.ceil(viewport.width);
			temporal.height = Math.ceil(viewport.height);
			const tarea = pagina.render({ canvasContext: temporal.getContext('2d'), viewport });
			this.tareas[pag.num] = tarea;
			try {
				await tarea.promise;
			} catch (e) {
				if (e && e.name === 'RenderingCancelledException') return;
				throw e;
			}
			const canvas = this.canvases[pag.num];
			if (!canvas || doc !== this.pdfDoc) return;
			canvas.width = temporal.width;
			canvas.height = temporal.height;
			canvas.getContext('2d').drawImage(temporal, 0, 0);
		},

		seFirma(num) {
			return this.paginasAFirmar.includes(num);
		},

		// ---------- Zoom ----------

		acercar() {
			this.zoom = Math.min(4, Math.floor(this.zoomPorcentaje / 25 + 1) * 0.25);
		},

		alejar() {
			this.zoom = Math.max(0.25, Math.ceil(this.zoomPorcentaje / 25 - 1) * 0.25);
		},

		// ---------- Lugares de firma ----------

		estadoDeFabrica() {
			return {
				lugares: (this.tipo ? TIPOS[this.tipo].lugares : []).map(l => ({ ...l, firmaId: null })),
				modoPagina: this.modoPagina
			};
		},

		// Arma los recuadros a partir de un estado guardado. Si el estado trae una firma guardada, va esa;
		// si no y "conservar" es true, queda la que ya estaba cargada en ese orden (para firmar varias actas
		// seguidas). Solo se conserva si la cantidad de lugares coincide: si no, el orden no dice nada y
		// una firma podría caer en el lugar de otra persona.
		aplicarEstado(estado, conservar) {
			const previas = this.lugares.map(l => l.firma);
			if (previas.length !== estado.lugares.length) conservar = false;
			const hoja = this.paginas[0];
			this.lugares = estado.lugares.map((l, i) => {
				// lo guardado puede venir de una hoja de otro tamaño: que no quede afuera
				const w = Math.min(l.w, hoja.ancho), h = Math.min(l.h, hoja.alto);
				const guardada = l.firmaId ? this.biblioteca.find(f => f.id === l.firmaId) : null;
				return {
					id: ++ultimoId, w, h,
					x: limitar(l.x, 0, hoja.ancho - w),
					y: limitar(l.y + this.desplazamiento, 0, hoja.alto - h),
					firma: guardada || (conservar ? previas[i] || null : null),
					sobre: false
				};
			});
			for (const f of previas) if (f && !this.firmaEnUso(f)) this.soltarUrl(f);
			let modo = estado.modoPagina || 'todas';
			if (typeof modo === 'number' && modo > this.paginas.length) modo = 'todas';
			this.modoPagina = modo;
		},

		agregarLugar() {
			const hoja = this.paginas[0];
			const w = 130, h = 55;
			this.lugares.push({ id: ++ultimoId, x: (hoja.ancho - w) / 2, y: 100, w, h, firma: null, sobre: false });
			this.persistir();
		},

		restaurarLugares() {
			this.aplicarEstado(this.estadoDeFabrica(), true);
			this.persistir();
		},

		firmaEnUso(f) {
			return this.lugares.some(l => l.firma === f);
		},

		// Libera la imagen en memoria, salvo que sea una firma guardada (la sigue usando la biblioteca)
		soltarUrl(f) {
			if (!f.id) URL.revokeObjectURL(f.url);
		},

		asignarFirma(lugar, firma) {
			const vieja = lugar.firma;
			lugar.firma = firma;
			if (vieja && vieja !== firma && !this.firmaEnUso(vieja)) this.soltarUrl(vieja);
			this.eligiendo = null;
			this.persistir();
		},

		quitarFirma(lugar) {
			const f = lugar.firma;
			if (!f) return;
			lugar.firma = null;
			if (!this.firmaEnUso(f)) this.soltarUrl(f);
			this.persistir();
		},

		quitarLugar(lugar) {
			const f = lugar.firma;
			this.lugares.splice(this.lugares.indexOf(lugar), 1);
			if (f && !this.firmaEnUso(f)) this.soltarUrl(f);
			this.persistir();
		},

		estiloLugar(l, pag) {
			return {
				left: (l.x / pag.ancho * 100) + '%',
				top: ((pag.alto - l.y - l.h) / pag.alto * 100) + '%',
				width: (l.w / pag.ancho * 100) + '%',
				height: (l.h / pag.alto * 100) + '%'
			};
		},

		// ---------- Mover y redimensionar ----------

		iniciarArrastre(e, lugar, pag, modo) {
			if (e.button !== 0) return;
			e.preventDefault();
			const rect = e.currentTarget.closest('.pagina').getBoundingClientRect();
			this.arrastre = {
				lugar, pag, modo, movido: false,
				escala: rect.width / pag.ancho,
				sx: e.clientX, sy: e.clientY,
				o: { x: lugar.x, y: lugar.y, w: lugar.w, h: lugar.h }
			};
			window.addEventListener('pointermove', this.moverArrastre);
			window.addEventListener('pointerup', this.terminarArrastre, { once: true });
		},

		moverArrastre(e) {
			const a = this.arrastre;
			if (!a) return;
			if (!a.movido && Math.hypot(e.clientX - a.sx, e.clientY - a.sy) < 4) return;
			a.movido = true;
			const dx = (e.clientX - a.sx) / a.escala;
			const dy = (e.clientY - a.sy) / a.escala; // hacia abajo en pantalla = y menor en el PDF
			const l = a.lugar, p = a.pag, o = a.o;
			if (a.modo === 'mover') {
				l.x = limitar(o.x + dx, 0, p.ancho - l.w);
				l.y = limitar(o.y - dy, 0, p.alto - l.h);
			} else {
				// el borde de arriba queda fijo
				l.w = limitar(o.w + dx, 30, p.ancho - o.x);
				l.h = limitar(o.h + dy, 20, o.y + o.h);
				l.y = o.y + o.h - l.h;
			}
		},

		terminarArrastre() {
			window.removeEventListener('pointermove', this.moverArrastre);
			const a = this.arrastre;
			this.arrastre = null;
			if (!a) return;
			if (a.movido) this.persistir();
			else if (a.modo === 'mover') this.elegirFirma(a.lugar);
		},

		// ---------- Imágenes de firma ----------

		// Con firmas guardadas se elige de la lista; si no, directo al selector de archivos
		elegirFirma(lugar) {
			if (this.biblioteca.length) this.eligiendo = lugar;
			else this.abrirSelectorArchivo(lugar);
		},

		abrirSelectorArchivo(lugar) {
			this.destino = lugar;
			this.$refs.inputFirma.value = '';
			this.$refs.inputFirma.click();
		},

		subirDesdeSelector() {
			const lugar = this.eligiendo;
			this.eligiendo = null;
			this.abrirSelectorArchivo(lugar);
		},

		alElegirFirma(e) {
			const file = e.target.files[0];
			if (file && this.destino) this.cargarFirma(file, this.destino);
		},

		soltarFirma(e, lugar) {
			lugar.sobre = false;
			const file = e.dataTransfer.files[0];
			if (file) this.cargarFirma(file, lugar);
		},

		async cargarFirma(file, lugar) {
			if (!['image/png', 'image/jpeg'].includes(file.type)) {
				this.avisar('La firma tiene que ser una imagen PNG o JPG', 'aviso');
				return;
			}
			const bytes = await file.arrayBuffer();
			const nueva = { id: null, nombre: file.name, tipo: file.type, bytes, url: URL.createObjectURL(file) };
			let firma = nueva;
			if (this.prefs.guardarFirmas) {
				try {
					firma = await this.guardarEnBiblioteca(nueva);
				} catch (e) {
					console.error(e);
					this.avisar('No pude guardar la firma en este navegador: queda cargada solo por ahora', 'aviso');
				}
			}
			if (firma !== nueva) URL.revokeObjectURL(nueva.url); // ya estaba guardada: se usa esa
			if (!this.lugares.includes(lugar)) { this.soltarUrl(firma); return; } // el lugar se borró mientras tanto
			this.asignarFirma(lugar, firma);
		},

		// ---------- Generar ----------

		// Genera el PDF firmado en memoria y devuelve los bytes (o null si falla la validación)
		async generarPDFBytes() {
			if (!this.pdfBytes) {
				this.avisar('Abrí primero el PDF del acta', 'aviso');
				return null;
			}

			const conFirma = this.lugares.filter(l => l.firma);
			if (conFirma.length === 0) {
				this.avisar('Cargá al menos una firma', 'aviso');
				return null;
			}

			const pdfDoc = await PDFLib.PDFDocument.load(this.pdfBytes);
			const pages = pdfDoc.getPages();

			const imagenes = new Map(); // la misma firma en varios lugares se incrusta una sola vez
			for (const l of conFirma) {
				if (imagenes.has(l.firma.bytes)) continue;
				imagenes.set(l.firma.bytes, l.firma.tipo === 'image/png'
					? await pdfDoc.embedPng(l.firma.bytes)
					: await pdfDoc.embedJpg(l.firma.bytes));
			}

			for (const num of this.paginasAFirmar) {
				const page = pages[num - 1];
				for (const l of conFirma) {
					// Igual que en pantalla: se ajusta al recuadro sin deformarse, centrada y apoyada abajo
					const img = imagenes.get(l.firma.bytes);
					const r = Math.min(l.w / img.width, l.h / img.height);
					const w = img.width * r, h = img.height * r;
					page.drawImage(img, { x: l.x + (l.w - w) / 2, y: l.y, width: w, height: h });
				}
			}

			this.persistir();
			return await pdfDoc.save();
		},

		cerrarPreview() {
			if (!this.preview) return;
			URL.revokeObjectURL(this.preview.url);
			this.preview = null;
		},

		async previsualizarPDF() {
			try {
				const bytes = await this.generarPDFBytes();
				if (!bytes) return;
				const blob = new Blob([bytes], { type: 'application/pdf' });
				this.cerrarPreview();
				this.preview = { blob, url: URL.createObjectURL(blob) };
			} catch (e) {
				console.error(e);
				this.avisar('Error al procesar el PDF: ' + e.message, 'error');
			}
		},

		descargar(blob) {
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = this.pdfFile.name.replace(/\.pdf$/i, '') + '_firmado.pdf';
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
			const n = this.paginasAFirmar.length;
			this.avisar(`Listo: firmas aplicadas en ${n === 1 ? '1 página' : n + ' páginas'}`, 'ok');
		},

		async firmarPDF() {
			try {
				const bytes = await this.generarPDFBytes();
				if (bytes) this.descargar(new Blob([bytes], { type: 'application/pdf' }));
			} catch (e) {
				console.error(e);
				this.avisar('Error al procesar el PDF: ' + e.message, 'error');
			}
		}
	}
}).mount('#app');
