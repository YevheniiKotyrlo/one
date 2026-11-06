import { Text, View } from 'react-native'

const { nativeLoggingHook } = globalThis as {
  nativeLoggingHook?: (message: string, level: number) => void
}

console.log('repro-console-line')
nativeLoggingHook?.(
  `repro-hook-line console._isPolyfilled=${String((console as { _isPolyfilled?: boolean })._isPolyfilled)}`,
  1
)

export default function Index() {
  return (
    <View
      style={{
        flex: 1,
        alignSelf: 'center',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100%',
      }}
    >
      <Text>Hello world, from One</Text>
    </View>
  )
}
