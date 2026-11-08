import { Stack, Tabs } from 'one'

export function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ focused }) => ({ type: 'materialSymbol', name: focused ? 'home' : 'house' }),
        }}
      />
    </Tabs>
  )
}

export function StackLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" options={{ title: 'Home' }} />
    </Stack>
  )
}
