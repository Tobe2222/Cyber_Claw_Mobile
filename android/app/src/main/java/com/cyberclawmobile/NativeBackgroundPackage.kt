package com.cyberclawmobile

import com.facebook.react.TurboReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Package to register background module
 */
class NativeBackgroundPackage : TurboReactPackage() {

  override fun getModule(
      name: String,
      reactContext: ReactApplicationContext
  ): NativeModule? {
    return if (name == NativeBackgroundModule.NAME) {
      NativeBackgroundModule(reactContext)
    } else {
      null
    }
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      mapOf(
          NativeBackgroundModule.NAME to ReactModuleInfo(
              name = NativeBackgroundModule.NAME,
              className = "NativeBackgroundModule",
              canOverrideExistingModule = true,
              needsEagerInit = false,
              isCxxModule = false,
              isTurboModule = true
          )
      )
    }
  }

  companion object {
    const val NAME = "NativeBackground"
  }
}
