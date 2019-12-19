/**
 * Copyright 2019 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Browser } from './Browser';
import { BrowserContext } from '../browserContext';
import { CDPSession, CDPSessionEvents } from './Connection';
import { Events } from '../events';
import { Worker } from './features/workers';
import { Page } from '../page';
import { Protocol } from './protocol';
import { debugError } from '../helper';
import { FrameManager } from './FrameManager';

const targetSymbol = Symbol('target');

export class Target {
  private _targetInfo: Protocol.Target.TargetInfo;
  private _browser: Browser;
  private _browserContext: BrowserContext;
  _targetId: string;
  private _sessionFactory: () => Promise<CDPSession>;
  private _pagePromise: Promise<Page> | null = null;
  private _frameManager: FrameManager | null = null;
  private _workerPromise: Promise<Worker> | null = null;
  _initializedPromise: Promise<boolean>;
  _initializedCallback: (value?: unknown) => void;
  _isInitialized: boolean;

  static fromPage(page: Page): Target {
    return (page as any)[targetSymbol];
  }

  constructor(
    browser: Browser,
    targetInfo: Protocol.Target.TargetInfo,
    browserContext: BrowserContext,
    sessionFactory: () => Promise<CDPSession>) {
    this._targetInfo = targetInfo;
    this._browser = browser;
    this._browserContext = browserContext;
    this._targetId = targetInfo.targetId;
    this._sessionFactory = sessionFactory;
    this._initializedPromise = new Promise(fulfill => this._initializedCallback = fulfill).then(async success => {
      if (!success)
        return false;
      const opener = this.opener();
      if (!opener || !opener._pagePromise || this.type() !== 'page')
        return true;
      const openerPage = await opener._pagePromise;
      if (!openerPage.listenerCount(Events.Page.Popup))
        return true;
      const popupPage = await this.page();
      openerPage.emit(Events.Page.Popup, popupPage);
      return true;
    });
    this._isInitialized = this._targetInfo.type !== 'page' || this._targetInfo.url !== '';
    if (this._isInitialized)
      this._initializedCallback(true);
  }

  _didClose() {
    if (this._frameManager)
      this._frameManager.didClose();
  }

  async page(): Promise<Page | null> {
    if ((this._targetInfo.type === 'page' || this._targetInfo.type === 'background_page') && !this._pagePromise) {
      this._pagePromise = this._sessionFactory().then(async client => {
        this._frameManager = new FrameManager(client, this._browser, this._browserContext);
        const page = this._frameManager.page();
        (page as any)[targetSymbol] = this;
        client.once(CDPSessionEvents.Disconnected, () => page._didDisconnect());
        client.on('Target.attachedToTarget', event => {
          if (event.targetInfo.type !== 'worker') {
            // If we don't detach from service workers, they will never die.
            client.send('Target.detachFromTarget', { sessionId: event.sessionId }).catch(debugError);
          }
        });
        await this._frameManager.initialize();
        await client.send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true});
        return page;
      });
    }
    return this._pagePromise;
  }

  async _worker(): Promise<Worker | null> {
    if (this._targetInfo.type !== 'service_worker' && this._targetInfo.type !== 'shared_worker')
      return null;
    if (!this._workerPromise) {
      // TODO(einbinder): Make workers send their console logs.
      this._workerPromise = this._sessionFactory()
          .then(client => new Worker(client, this._targetInfo.url, () => { } /* consoleAPICalled */, () => { } /* exceptionThrown */));
    }
    return this._workerPromise;
  }

  url(): string {
    return this._targetInfo.url;
  }

  type(): 'page' | 'background_page' | 'service_worker' | 'shared_worker' | 'other' | 'browser' {
    const type = this._targetInfo.type;
    if (type === 'page' || type === 'background_page' || type === 'service_worker' || type === 'shared_worker' || type === 'browser')
      return type;
    return 'other';
  }

  browserContext(): BrowserContext {
    return this._browserContext;
  }

  opener(): Target | null {
    const { openerId } = this._targetInfo;
    if (!openerId)
      return null;
    return this._browser._targets.get(openerId);
  }

  createCDPSession(): Promise<CDPSession> {
    return this._sessionFactory();
  }

  _targetInfoChanged(targetInfo: Protocol.Target.TargetInfo) {
    this._targetInfo = targetInfo;

    if (!this._isInitialized && (this._targetInfo.type !== 'page' || this._targetInfo.url !== '')) {
      this._isInitialized = true;
      this._initializedCallback(true);
      return;
    }
  }
}
