# Pulsewire keeps serialization models and OkHttp's defaults in release builds.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class dev.pulsewire.android.data.** {
    *** Companion;
}
-keepclasseswithmembers class dev.pulsewire.android.data.** {
    kotlinx.serialization.KSerializer serializer(...);
}
