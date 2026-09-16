import { StackActions, useNavigation } from "@react-navigation/native";
import { useLayoutEffect } from "react";

export function SettingsAuthRouteScreen() {
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.dispatch(StackActions.replace("SettingsContent"));
  }, [navigation]);
  return null;
}
