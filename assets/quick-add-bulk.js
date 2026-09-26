if (!customElements.get('quick-add-bulk')) {
  customElements.define(
    'quick-add-bulk',
    class QuickAddBulk extends BulkAdd {
      constructor() {
        super();
        this.quantity = this.querySelector('quantity-input');

        const debouncedOnChange = debounce((event) => {
          if (parseInt(event.target.value) === 0) {
            this.startQueue(event.target.dataset.index, parseInt(event.target.value));
          } else {
            this.validateQuantity(event);
          }
        }, ON_CHANGE_DEBOUNCE_TIMER);

        this.addEventListener('change', debouncedOnChange.bind(this));
        this.listenForActiveInput();
        this.listenForKeydown();
        this.lastActiveInputId = null;
      }

      connectedCallback() {
        this.cartUpdateUnsubscriber = subscribe(PUB_SUB_EVENTS.cartUpdate, (event) => {
          if (
            event.source === 'quick-add' ||
            (event.cartData.items && !event.cartData.items.some((item) => item.id === parseInt(this.dataset.index))) ||
            (event.cartData.variant_id && !(event.cartData.variant_id === parseInt(this.dataset.index)))
          ) {
            return;
          }
          // If its another section that made the update
          this.onCartUpdate().then(() => {
            this.listenForActiveInput();
            this.listenForKeydown();
          });
        });
      }

      disconnectedCallback() {
        if (this.cartUpdateUnsubscriber) {
          this.cartUpdateUnsubscriber();
        }
      }

      get input() {
        return this.querySelector('quantity-input input');
      }

      selectProgressBar() {
        return this.querySelector('.progress-bar-container');
      }

      listenForActiveInput() {
        if (!this.classList.contains('hidden')) {
          this.input?.addEventListener('focusin', (event) => event.target.select());
        }
        this.isEnterPressed = false;
      }

      listenForKeydown() {
        this.input?.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            this.input?.blur();
            this.isEnterPressed = true;
          }
        });
      }

      cleanErrorMessageOnType(event) {
        event.target.addEventListener(
          'keypress',
          () => {
            event.target.setCustomValidity('');
          },
          { once: true }
        );
      }

      get sectionId() {
        if (!this._sectionId) {
          this._sectionId = this.closest('.collection-quick-add-bulk').dataset.id;
        }

        return this._sectionId;
      }

      onCartUpdate() {
        return new Promise((resolve, reject) => {
          fetch(`${this.getSectionsUrl()}?section_id=${this.sectionId}`)
            .then((response) => response.text())
            .then((responseText) => {
              const html = new DOMParser().parseFromString(responseText, 'text/html');
              const sourceQty = html.querySelector(`#quick-add-bulk-${this.dataset.index}-${this.sectionId}`);
              if (sourceQty) {
                this.innerHTML = sourceQty.innerHTML;
              }
              resolve();
            })
            .catch((e) => {
              console.error(e);
              reject(e);
            });
        });
      }

      getSectionsUrl() {
        const pageParams = new URLSearchParams(window.location.search);
        const pageNumber = decodeURIComponent(pageParams.get('page') || '');

        return `${window.location.pathname}${pageNumber ? `?page=${pageNumber}` : ''}`;
      }

      updateMultipleQty(items) {
        this.selectProgressBar().classList.remove('hidden');

        const giftVariantId = Number(this.dataset.autoGiftVariantId || 0);
        const giftProductId = Number(this.dataset.autoGiftProductId || 0);
        const currentVariantId = Number(this.dataset.index);
        const qualifiesForGift = this.dataset.autoGiftQualifies === 'true';
        const requestedQuantity = Number(items[currentVariantId] || 0);

        const updateCart = (updates) => {
          const ids = Object.keys(updates);
          const linesUpdate = this.startCartLinesUpdate(updates);
          const body = JSON.stringify({
            updates,
            sections: this.getSectionsToRender().map((section) => section.section),
            sections_url: this.getSectionsUrl(),
          });

          fetch(`${routes.cart_update_url}`, { ...fetchConfig(), ...{ body } })
            .then((response) => response.json())
            .then((parsedState) => {
              if (parsedState.errors) {
                throw Object.assign(new Error(parsedState.errors), { code: 'INVALID' });
              }
              if (
                qualifiesForGift &&
                requestedQuantity > 0 &&
                !(parsedState.items || []).some((item) => Number(item.product_id) === giftProductId)
              ) {
                throw Object.assign(new Error(window.cartStrings.error), { code: 'INVALID' });
              }

              linesUpdate?.resolve(parsedState);
              this.renderSections(parsedState, ids);
              publish(PUB_SUB_EVENTS.cartUpdate, { source: 'quick-add', cartData: parsedState });
            })
            .catch((e) => {
              if (e.code !== 'INVALID') console.error(e);
              this.dispatchCartErrorEvent(
                e.code === 'INVALID' ? e.message : window.cartStrings.error,
                e.code || 'SERVICE_UNAVAILABLE'
              );
              linesUpdate?.reject(e);
            })
            .finally(() => {
              this.selectProgressBar().classList.add('hidden');
              this.setRequestStarted(false);
            });
        };

        if (!qualifiesForGift || requestedQuantity <= 0 || !giftVariantId || !giftProductId) {
          if (qualifiesForGift && requestedQuantity > 0 && (!giftVariantId || !giftProductId)) {
            this.dispatchCartErrorEvent(
              this.dataset.autoGiftErrorMessage || window.cartStrings.error,
              'INVALID'
            );
            this.selectProgressBar().classList.add('hidden');
            this.setRequestStarted(false);
            return;
          }
          updateCart(items);
          return;
        }

        fetch(`${routes.cart_url}.js`, { headers: { Accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error(window.cartStrings.error);
            return response.json();
          })
          .then((cart) => {
            const giftAlreadyInCart = (cart.items || []).some(
              (item) => Number(item.product_id) === giftProductId
            );
            const updates = { ...items };
            if (!giftAlreadyInCart && giftVariantId !== currentVariantId) {
              updates[giftVariantId] = 1;
            }
            updateCart(updates);
          })
          .catch((error) => {
            console.error('Unable to add the automatic gift from quick add.', error);
            this.dispatchCartErrorEvent(
              this.dataset.autoGiftErrorMessage || window.cartStrings.error,
              'SERVICE_UNAVAILABLE'
            );
            this.selectProgressBar().classList.add('hidden');
            this.setRequestStarted(false);
          });
      }

      getSectionsToRender() {
        return [
          {
            id: `quick-add-bulk-${this.dataset.index}-${this.sectionId}`,
            section: this.sectionId,
            selector: `#quick-add-bulk-${this.dataset.index}-${this.sectionId}`,
          },
          {
            id: 'cart-icon-bubble',
            section: 'cart-icon-bubble',
            selector: '.shopify-section',
          },
          {
            id: 'CartDrawer',
            selector: '.drawer__inner',
            section: 'cart-drawer',
          },
        ];
      }

      renderSections(parsedState, ids) {
        const intersection = this.queue.filter((element) => ids.includes(element.id));
        if (intersection.length !== 0) return;
        this.getSectionsToRender().forEach((section) => {
          const sectionElement = document.getElementById(section.id);
          if (section.section === 'cart-drawer') {
            sectionElement.closest('cart-drawer')?.classList.toggle('is-empty', parsedState.items.length.length === 0);
          }
          const elementToReplace =
            sectionElement && sectionElement.querySelector(section.selector)
              ? sectionElement.querySelector(section.selector)
              : sectionElement;
          if (elementToReplace) {
            elementToReplace.innerHTML = this.getSectionInnerHTML(
              parsedState.sections[section.section],
              section.selector
            );
          }
        });

        if (this.isEnterPressed) {
          this.querySelector(`#Quantity-${this.lastActiveInputId}`).select();
        }

        this.listenForActiveInput();
        this.listenForKeydown();
      }
    }
  );
}
